// services/sienge/paymentFlow/modules/medicao.js
//
// Módulo MEDIÇÃO: mede o valor do lançamento no contrato (Playwright), anexa
// NF/boleto/extras à medição e acompanha a autorização. Quando autoriza:
//   - com documento fiscal -> dispara o Título;
//   - receita "medição antes do documento" e ainda sem NF -> para em
//     `awaiting_document` até a nota ser anexada (titulo.stepAttachDocument).

import { SiengeContractService } from '../../SiengeContractService.js';
import { runPlaywrightMeasurement } from '../../../../playwright/services/measurementService.js';
import { pickMeasurementItem } from '../measurementItem.js';
import {
    Model, loadLaunch, patch, resolveEnterpriseIds, getUserSiengeCredentials, fmtDate,
    attachMeasurementFiles, recipeOfLaunch, gateMessage,
} from '../shared.js';
import { stepCreateTitulo } from './titulo.js';

function addDays(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

export async function stepCreateMeasurement(launchId, userId = null) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeDocumentId || !launch.siengeContractNumber) {
        throw new Error('Execute stepFindContract primeiro.');
    }

    await patch(launch, {
        pipelineStage: 'creating_measurement',
        status: 'medicao',
        siengeMeasurementError: null,
        // Reseta campos anteriores para evitar dados obsoletos em reprocessamento
        siengeMeasurementNumber: null,
        siengeMeasurementAuthorized: false,
        siengeMeasurementApproval: null,
    });

    const { receita } = await recipeOfLaunch(launch);
    const { erpId } = await resolveEnterpriseIds(launch);

    // Vencimento da medição = vencimento do boleto. No modo auto segue o
    // fallback de sempre (término do contrato). Nos modos novos o término pode
    // estar a um ano de distância (contrato anual do salário), então sem boleto
    // o vencimento vai para daqui a 7 dias - o título ajusta depois.
    const dataVencimento = fmtDate(
        launch.boletoDueDate
        || (receita.contrato === 'auto' ? launch.contractEndDate : addDays(7))
        || '',
    );

    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);

    // ── Linha do contrato que recebe a medição ────────────────────────────────
    // O item de orçamento do tipo manda; o saldo só desempata. No modo
    // "existente" é estrito: sem o item do tipo com saldo, NÃO mede (mediria
    // em outra verba do contrato, como a premiação no CTPJ do salário).
    const strict = receita.contrato === 'existente';
    let targetRowIndex = 1;
    try {
        const targetValue = Number(launch.unitPrice) || 0;
        const { items } = await SiengeContractService.validateItems(
            launch.siengeDocumentId,
            launch.siengeContractNumber,
            erpId || launch.enterpriseId,
            1,           // buildingUnitId COMERCIAL
            targetValue,
        );

        if (items.length > 0) {
            await patch(launch, { siengeItemsRaw: items });
            const pick = pickMeasurementItem(items, {
                budgetItem: launch.budgetItem,
                budgetItemCode: launch.budgetItemCode,
                value: targetValue,
                strict,
            });
            if (pick.rowIndex) {
                targetRowIndex = pick.rowIndex;
                await patch(launch, {
                    siengeItemBalanceOk: pick.balance >= targetValue - 0.005,
                    siengeItemBalanceAvailable: pick.balance,
                });
                console.log(
                    `🎯 [Pipeline] #${launchId}: item "${pick.item.description}"` +
                    ` | saldo=${pick.balance.toFixed(2)} | porItem=${pick.porItem} | targetRowIndex=${targetRowIndex}`,
                );
            } else if (strict) {
                await patch(launch, {
                    pipelineStage: 'measurement_error',
                    status: 'erro',
                    siengeMeasurementError: gateMessage([pick.motivo]),
                });
                return { success: false, error: pick.motivo };
            }
        } else if (strict) {
            const msg = 'Itens do contrato não retornaram da API do Sienge; medição não feita para não medir no item errado.';
            await patch(launch, { pipelineStage: 'measurement_error', status: 'erro', siengeMeasurementError: msg });
            return { success: false, error: msg };
        }
    } catch (err) {
        if (strict) {
            const msg = `Não foi possível ler os itens do contrato: ${err.message}`;
            await patch(launch, { pipelineStage: 'measurement_error', status: 'erro', siengeMeasurementError: msg });
            return { success: false, error: msg };
        }
        console.warn(`⚠️ [Pipeline] #${launchId}: seleção de item falhou, usando 1º editável. ${err.message}`);
    }

    const playwrightPayload = {
        documentType: launch.siengeDocumentId,
        contractNumber: String(launch.siengeContractNumber),
        obraCod: String(erpId || launch.enterpriseId || ''),
        dataVencimento,
        value: String(launch.unitPrice || ''),
        targetRowIndex,
        credentials,
    };

    try {
        const result = await runPlaywrightMeasurement(playwrightPayload);

        await patch(launch, {
            pipelineStage: 'measurement_created',
            siengeMeasurementNumber: result.measurementNumber || null,
            siengeMeasurementAuthorized: false,
            siengeMeasurementApproval: 'PENDING',
            siengeMeasurementError: null,
        });

        // Anexar arquivos do lançamento à medição (NF, boleto, extras)
        if (result.measurementNumber) {
            const attachResults = await attachMeasurementFiles(
                launch,
                erpId || launch.enterpriseId,
                result.measurementNumber
            ).catch(err => {
                console.warn(`⚠️  [Pipeline] #${launchId}: Erro geral ao anexar arquivos: ${err.message}`);
                return [];
            });
            const ok = attachResults.filter(r => r.ok).length;
            console.log(`📎 [Pipeline] #${launchId}: ${ok}/${attachResults.length} anexo(s) enviado(s) à medição #${result.measurementNumber}`);
        }

        // Avança para aguardar autorização da medição
        await patch(launch, { pipelineStage: 'awaiting_measurement_authorization' });

        return { success: true, measurementNumber: result.measurementNumber };
    } catch (err) {
        const msg = err.message || 'Erro desconhecido no Playwright (medição)';
        const isCredentialsError = msg.startsWith('CREDENCIAIS_INVALIDAS:');
        await patch(launch, {
            pipelineStage: 'measurement_error',
            status: 'erro',
            siengeMeasurementError: msg,
            ...(isCredentialsError && { siengeCredentialsInvalid: true }),
        });
        return { success: false, error: msg };
    }
}

// ── Polling de autorização da medição ─────────────────────────────────────────
export async function pollMeasurementStatus(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeMeasurementNumber) return null;

    const { erpId } = await resolveEnterpriseIds(launch);
    const buildingId = erpId || launch.enterpriseId;
    if (!buildingId) return null;

    const measurement = await SiengeContractService.getMeasurement(
        launch.siengeDocumentId,
        launch.siengeContractNumber,
        buildingId,
        launch.siengeMeasurementNumber
    );
    if (!measurement) return null;

    const isAuthorized = measurement.authorized === true;

    await launch.update({
        siengeMeasurementAuthorized: isAuthorized,
        // statusApproval: D=DISAPPROVED | A=APPROVED | null = aguardando
        siengeMeasurementApproval: measurement.statusApproval || null,
    });

    console.log(`🔍 [Pipeline] #${launchId}: medição #${launch.siengeMeasurementNumber} | authorized=${isAuthorized}`);

    if (isAuthorized && launch.pipelineStage === 'awaiting_measurement_authorization') {
        // Sem número de nota o título NUNCA sai: espera o documento. Vale para a
        // receita "medição antes do documento" e para medição importada do
        // Sienge (que chega sem nota) - antes o robô liberava título vazio.
        const semDocumento = !launch.nfNumber;
        const nextStage = semDocumento ? 'awaiting_document' : 'creating_titulo';

        // Update atômico: apenas 1 chamada concurrent (scheduler vs pollNow) avança o stage
        const [changed] = await Model().update(
            { pipelineStage: nextStage, ...(nextStage === 'awaiting_document' && { status: 'medicao' }) },
            { where: { id: launchId, pipelineStage: 'awaiting_measurement_authorization' } }
        );
        if (changed > 0 && nextStage === 'awaiting_document') {
            console.log(`📄 [Pipeline] #${launchId}: medição autorizada — aguardando o documento fiscal para gerar o título.`);
        } else if (changed > 0) {
            console.log(`🚀 [Pipeline] #${launchId}: medição autorizada → iniciando criação de título automaticamente...`);
            // Não await — roda em background para não bloquear o scheduler
            stepCreateTitulo(launchId, launch.createdBy).catch(err =>
                console.error(`❌ [Pipeline] #${launchId}: falha ao criar título automático: ${err.message}`)
            );
        } else {
            console.log(`ℹ️  [Pipeline] #${launchId}: título já iniciado por outra instância — ignorando.`);
        }
    }

    return measurement;
}
