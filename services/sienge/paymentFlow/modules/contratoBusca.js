// services/sienge/paymentFlow/modules/contratoBusca.js
//
// Módulo CONTRATO - busca (modo "auto" da receita): acha o melhor contrato do
// fornecedor na empresa/obra, valida saldo e acompanha a autorização do
// contrato/aditivo no Sienge. Quando autoriza, dispara a Medição.

import { SiengeContractService, DEFAULT_BUILDING_UNIT } from '../../SiengeContractService.js';
import { SiengeBillsService } from '../../SiengeBillsService.js';
import { Model, loadLaunch, patch, resolveEnterpriseIds, recipeOfLaunch } from '../shared.js';
import { pickByDocuments } from '../gate.js';
import { stepCreateMeasurement } from './medicao.js';

export async function stepFindContract(launchId) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeCreditorId) throw new Error('Execute stepFindCreditor primeiro.');

    await patch(launch, { pipelineStage: 'searching_contract', status: 'contrato' });

    const { erpId, companyId } = await resolveEnterpriseIds(launch);

    // Receita com documentos de contrato (ex.: RB): só contrato desses
    // documentos conta. Sem isso o reembolso de um gestor cairia no CTPJ do
    // salário dele na mesma empresa.
    const { receita } = await recipeOfLaunch(launch);
    const docs = receita.documentosContrato || [];

    let contract;
    try {
        contract = docs.length
            ? pickByDocuments(await SiengeContractService.findAllBySupplierId(launch.siengeCreditorId, companyId), docs, erpId)
            : await SiengeContractService.findBySupplierId(
                launch.siengeCreditorId,
                companyId,
                erpId   // buildingId — filtra por obra no servidor
            );
    } catch (err) {
        await patch(launch, {
            pipelineStage: 'contract_not_found',
            siengeContractStatus: 'error',
            status: 'erro',
            siengeContractError: err.message,
        });
        throw err;
    }

    if (!contract) {
        await patch(launch, { pipelineStage: 'contract_not_found', siengeContractStatus: 'not_found' });
        return { found: false };
    }

    await patch(launch, {
        pipelineStage: 'contract_found',
        siengeContractStatus: 'found',
        siengeDocumentId: contract.documentId,
        siengeContractNumber: contract.contractNumber,
        siengeContractApproval: contract.statusApproval,
        siengeContractAuthorized: contract.isAuthorized,
        siengeContractAuthLevel: contract.currentAuthorizationLevel || null,
        contractStartDate: contract.startDate || null,
        contractEndDate: contract.endDate || null,
        siengeContractRaw: contract,
    });
    return { found: true, contract };
}

// ── Validar itens (saldo) ─────────────────────────────────────────────────────
export async function stepValidateItems(launchId) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeDocumentId || !launch.siengeContractNumber) {
        throw new Error('Execute stepFindContract primeiro.');
    }

    await patch(launch, { pipelineStage: 'validating_items' });

    const { erpId, companyId } = await resolveEnterpriseIds(launch);

    const result = await SiengeContractService.validateItems(
        launch.siengeDocumentId,
        launch.siengeContractNumber,
        erpId || launch.enterpriseId,
        DEFAULT_BUILDING_UNIT,
        launch.unitPrice
    );

    // ── Saldo insuficiente: verifica se já foi lançado/pago anteriormente ────
    if (!result.ok) {
        const billCheck = await SiengeBillsService.checkPreviousLaunch({
            creditorId: launch.siengeCreditorId,
            debtorId: companyId || launch.companyId,
            costCenterId: erpId || launch.enterpriseId,
            documentNumber: launch.nfNumber,
            amount: launch.unitPrice,
        });

        if (billCheck.status === 'cravado') {
            // Documento + valor batem → certamente já foi lançado antes
            await patch(launch, {
                pipelineStage: 'items_insufficient',
                status: 'erro',
                siengeItemsRaw: result.items,
                siengeItemBalanceOk: false,
                siengeItemBalanceAvailable: result.balanceAvailable,
                siengeContractError: [
                    `⚠️ Saldo insuficiente, mas este lançamento JÁ FOI REGISTRADO anteriormente.`,
                    `Título encontrado no Sienge: doc "${billCheck.bill.documentNumber}"`,
                    `Valor: R$ ${billCheck.bill.totalInvoiceAmount}`,
                    `Emissão: ${billCheck.bill.issueDate}`,
                    `Status: ${billCheck.bill.status}`,
                ].join(' | '),
            });
            return {
                ...result,
                ok: false,
                previousLaunch: { status: 'cravado', bill: billCheck.bill },
            };
        }

        if (billCheck.status === 'suspeito') {
            // Valor bate mas documento difere → alerta, não bloqueia
            const warningMsg = [
                `⚠️ Saldo insuficiente. Encontrado título com valor semelhante (possível lançamento anterior).`,
                `Doc no Sienge: "${billCheck.bill.documentNumber}"`,
                `Valor: R$ ${billCheck.bill.totalInvoiceAmount}`,
                `Emissão: ${billCheck.bill.issueDate}`,
                `Verifique se já foi pago antes de criar novo contrato.`,
            ].join(' | ');

            await patch(launch, {
                pipelineStage: 'items_insufficient',
                status: 'erro',
                siengeItemsRaw: result.items,
                siengeItemBalanceOk: false,
                siengeItemBalanceAvailable: result.balanceAvailable,
                siengeContractError: warningMsg,
            });
            return {
                ...result,
                ok: false,
                previousLaunch: { status: 'suspeito', bill: billCheck.bill },
            };
        }

        // Nenhum título encontrado → saldo genuinamente insuficiente
        await patch(launch, {
            pipelineStage: 'items_insufficient',
            status: 'erro',
            siengeItemsRaw: result.items,
            siengeItemBalanceOk: false,
            siengeItemBalanceAvailable: result.balanceAvailable,
            siengeContractError: result.error || 'Saldo insuficiente no contrato.',
        });
        return { ...result, ok: false, previousLaunch: { status: 'nenhum', bill: null } };
    }

    // Saldo OK
    await patch(launch, {
        pipelineStage: 'items_ok',
        siengeItemsRaw: result.items,
        siengeItemBalanceOk: true,
        siengeItemBalanceAvailable: result.balanceAvailable,
        siengeContractError: null,
    });
    await patch(launch, { pipelineStage: 'ready' });
    return { ...result, ok: true, previousLaunch: null };
}

// ── Polling de autorização do contrato/aditivo ────────────────────────────────
export async function pollContractStatus(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeDocumentId || !launch?.siengeContractNumber) return null;

    const contract = await SiengeContractService.getByIds(
        launch.siengeDocumentId,
        launch.siengeContractNumber
    );
    if (!contract) return null;

    await launch.update({
        siengeContractApproval: contract.statusApproval,
        siengeContractAuthorized: contract.isAuthorized,
        siengeContractAuthLevel: contract.currentAuthorizationLevel || null,
        siengeContractRaw: contract,
        contractStartDate: contract.startDate || launch.contractStartDate,
        contractEndDate: contract.endDate || launch.contractEndDate,
    });

    // Quando autorizado E ainda em awaiting_authorization → dispara medição automaticamente
    // Update atômico: apenas 1 chamada concurrent (scheduler vs pollNow) avança o stage
    if (contract.isAuthorized && launch.pipelineStage === 'awaiting_authorization') {
        const [changed] = await Model().update(
            { pipelineStage: 'creating_measurement' },
            { where: { id: launchId, pipelineStage: 'awaiting_authorization' } }
        );
        if (changed > 0) {
            console.log(`🚀 [Pipeline] #${launchId}: contrato/aditivo autorizado — iniciando medição automaticamente...`);
            // Não await — roda em background para não bloquear o scheduler
            stepCreateMeasurement(launchId, launch.createdBy).catch(err =>
                console.error(`❌ [Pipeline] #${launchId}: falha ao criar medição automática: ${err.message}`)
            );
        } else {
            console.log(`ℹ️  [Pipeline] #${launchId}: medição já iniciada por outra instância — ignorando.`);
        }
    }

    return contract;
}
