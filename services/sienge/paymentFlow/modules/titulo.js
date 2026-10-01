// services/sienge/paymentFlow/modules/titulo.js
//
// Módulo TÍTULO: libera a medição autorizada como título (Playwright) e cuida
// do pagamento. Variações pela receita do tipo:
//   documento  - NFS, NFE (exige chave de acesso), RPA, RB... ou o do lançamento
//   pagamento  - boleto (registra a linha digitável na parcela) ou
//                transferência (sem boleto: vai direto aguardar o pagamento)
// Também recebe o documento fiscal quando a receita mede antes da nota
// (stepAttachDocument).

import axios from 'axios';
import { SiengeBillsService } from '../../SiengeBillsService.js';
import { runPlaywrightTitulo } from '../../../../playwright/services/tituloService.js';
import { checkDocument } from '../gate.js';
import {
    Model, loadLaunch, patch, getUserSiengeCredentials, recipeOfLaunch, gateMessage,
} from '../shared.js';

export async function stepCreateTitulo(launchId, userId = null) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeMeasurementNumber) throw new Error('Medição não encontrada — execute stepCreateMeasurement primeiro.');

    const { receita, typeConfig } = await recipeOfLaunch(launch);

    // Portão: o documento tem que bater com a receita ANTES de abrir o Sienge.
    const docMotivos = checkDocument(launch, receita);
    if (docMotivos.length) {
        const semNota = !launch.nfNumber && receita.medicaoAntesDoDocumento;
        await patch(launch, {
            pipelineStage: semNota ? 'awaiting_document' : 'titulo_error',
            status: semNota ? 'medicao' : 'erro',
            siengeTituloError: semNota ? null : gateMessage(docMotivos),
        });
        return { success: false, error: docMotivos.join(' | '), awaitingDocument: semNota };
    }

    await patch(launch, {
        pipelineStage: 'creating_titulo',
        status: 'titulo',
        siengeTituloError: null,
        // Reseta campos anteriores para evitar dados obsoletos em reprocessamento
        siengeTituloNumber: null,
        siengeTituloStatus: null,
    });

    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);
    const departamento = String(typeConfig?.departamentoId || '24');
    const nfType = receita.titulo.documento || String(launch.nfType || '').trim().toUpperCase() || 'NFS';

    const playwrightPayload = {
        documentType: launch.siengeDocumentId,
        contractNumber: String(launch.siengeContractNumber),
        measurementNumber: Number(launch.siengeMeasurementNumber),
        nfType,
        nfNumber: launch.nfNumber || '',
        nfIssueDate: launch.nfIssueDate || '',
        nfAccessKey: nfType === 'NFE' ? String(launch.nfAccessKey || '').replace(/\D/g, '') : '',
        boletoDueDate: launch.boletoDueDate || '',
        departamento,
        unitPrice: String(launch.unitPrice || ''),
        credentials,
    };

    try {
        const result = await runPlaywrightTitulo(playwrightPayload);

        await patch(launch, {
            pipelineStage: 'titulo_created',
            siengeTituloNumber: result.tituloNumber || null,
            siengeTituloError: null,
        });

        console.log(`✅ [Pipeline] #${launchId}: título #${result.tituloNumber} criado com sucesso`);
        for (const aviso of result.avisos || []) console.warn(`⚠️  [Pipeline] #${launchId}: ${aviso}`);

        if (result.tituloNumber) {
            if (receita.titulo.pagamento === 'transferencia') {
                // Sem boleto para registrar: o título já espera o pagamento.
                await patch(launch, { pipelineStage: 'awaiting_titulo_authorization' });
            } else if (receita.titulo.pagamento === 'pix') {
                // O robô do título não grava forma de pagamento, e a API é só
                // consulta: o PIX é escolhido no Sienge. O lançamento avisa.
                const doc = String(launch.providerCnpj || '').trim();
                await patch(launch, {
                    siengeTituloError: `Título ${result.tituloNumber} lançado sem forma de pagamento: selecione PIX na parcela, chave ${doc} (${launch.siengeCreditorName || launch.providerName}).`,
                });
            } else {
                // Registra boleto automaticamente em background
                stepRegisterBoleto(launchId).catch(err =>
                    console.error(`❌ [Pipeline] #${launchId}: falha ao registrar boleto: ${err.message}`)
                );
            }
        }

        return { success: true, tituloNumber: result.tituloNumber };
    } catch (err) {
        const msg = err.message || 'Erro desconhecido no Playwright (título)';
        const isCredentialsError = msg.startsWith('CREDENCIAIS_INVALIDAS:');
        await patch(launch, {
            pipelineStage: 'titulo_error',
            status: 'erro',
            siengeTituloError: msg,
            ...(isCredentialsError && { siengeCredentialsInvalid: true }),
        });
        return { success: false, error: msg };
    }
}

// Erros de registro de boleto que NÃO se resolvem com retry (ex.: linha digitável
// inválida -> Sienge 400). Nesses casos a esteira encerra a tentativa automática e
// instrui o registro manual no Sienge, em vez de retentar a cada ciclo do scheduler.
export function isPermanentBoletoError(message) {
    return /\bSienge 400\b|linha digit[aá]vel.*inv[aá]lid/i.test(String(message || ''));
}

// ── Registrar boleto na parcela do título ─────────────────────────────────────
export async function stepRegisterBoleto(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeTituloNumber) return { success: false, reason: 'sem_titulo' };
    if (!launch.boletoBarcode) return { success: false, reason: 'sem_barcode' };

    try {
        const installments = await SiengeBillsService.getInstallments(launch.siengeTituloNumber);
        if (!installments.length) {
            console.warn(`⚠️  [Pipeline] #${launchId}: nenhuma parcela encontrada para título #${launch.siengeTituloNumber}`);
            return { success: false, reason: 'sem_parcelas' };
        }

        const installment = installments[0]; // título único → 1 parcela
        console.log(`[Pipeline] #${launchId}: parcela encontrada → ${JSON.stringify(installment)}`);

        // Sienge usa installmentNumber como id da parcela no path
        const installmentId = installment.installmentNumber ?? installment.indexId ?? 1;
        await SiengeBillsService.registerBoletoPayment(
            launch.siengeTituloNumber,
            installmentId,
            launch.boletoBarcode
        );

        await launch.update({ pipelineStage: 'awaiting_titulo_authorization' });
        console.log(`✅ [Pipeline] #${launchId}: boleto registrado na parcela #${installment.installmentNumber} do título #${launch.siengeTituloNumber}`);
        return { success: true, installmentNumber: installment.installmentNumber };
    } catch (err) {
        // Não bloqueia o fluxo — salva o erro no banco para visibilidade no frontend
        console.error(`❌ [Pipeline] #${launchId}: erro ao registrar boleto: ${err.message}`);
        // Linha digitável inválida (Sienge 400) é erro permanente: retentar não resolve.
        const permanent = isPermanentBoletoError(err.message);
        if (permanent) {
            console.warn(`⚠️  [Pipeline] #${launchId}: linha digitável inválida - registre o boleto manualmente no Sienge. Retry automático encerrado.`);
        }
        try {
            const l = await Model().findByPk(launchId, { attributes: ['id', 'pipelineStage'] });
            // Só salva o erro se o stage ainda é titulo_created (não sobrescreve se já avançou)
            if (l?.pipelineStage === 'titulo_created') {
                const msg = permanent
                    ? `${err.message} Registre o boleto manualmente no Sienge.`
                    : `Erro ao registrar boleto: ${err.message}`;
                await l.update({ siengeTituloError: msg });
            }
        } catch (_) { /* silencioso */ }
        return permanent
            ? { success: false, reason: 'manual_required', error: err.message }
            : { success: false, error: err.message };
    }
}

// ── Polling de status do título ────────────────────────────────────────────────
export async function pollTituloStatus(launchId) {
    const launch = await Model().findByPk(launchId);
    if (!launch?.siengeTituloNumber) return null;

    const bill = await SiengeBillsService.getBill(launch.siengeTituloNumber);
    if (!bill) return null;

    // Fonte primária: situação das parcelas via GET /bills/{id}/installments
    const installments = await SiengeBillsService.getInstallments(launch.siengeTituloNumber);
    const isPaid = installments.length > 0
        && installments.every(i => i.situation === 'Totalmente paga');

    await launch.update({ siengeTituloStatus: bill.status || null });

    const situacoes = installments.map(i => i.situation).join(', ') || bill.status || '?';
    console.log(`🔍 [Pipeline] #${launchId}: título #${launch.siengeTituloNumber} | parcelas=[${situacoes}] | pago=${isPaid}`);

    // Detecta pagamento mesmo quando o boleto falhou ao registrar (stage fica em 'titulo_created').
    // O erro de registro (siengeTituloError) é preservado — notificação e reenvio continuam disponíveis.
    const PAYABLE_STAGES = ['awaiting_titulo_authorization', 'titulo_created'];
    if (isPaid && PAYABLE_STAGES.includes(launch.pipelineStage)) {
        await launch.update({ pipelineStage: 'titulo_pago', status: 'titulo_pago' });
        console.log(`✅ [Pipeline] #${launchId}: título pago → titulo_pago`);
    }

    return bill;
}

// ── Atualizar boleto de um título já existente ────────────────────────────────
export async function stepUpdateBoleto(launchId, { boletoUrl, boletoPath, boletoFilename, boletoBarcode, boletoDueDate, boletoAmount }) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeTituloNumber) return { success: false, reason: 'sem_titulo' };
    if (!boletoBarcode) return { success: false, reason: 'sem_barcode' };
    if (!boletoUrl) return { success: false, reason: 'sem_url' };

    // 1. Atualiza dados do boleto no banco
    await launch.update({
        boletoUrl: boletoUrl,
        boletoPath: boletoPath || launch.boletoPath,
        boletoFilename: boletoFilename || launch.boletoFilename,
        boletoBarcode,
        boletoDueDate: boletoDueDate || launch.boletoDueDate,
        boletoAmount: boletoAmount || launch.boletoAmount,
        siengeTituloError: null,
    });

    // 2. Atualiza o código de barras na parcela do Sienge
    try {
        const installments = await SiengeBillsService.getInstallments(launch.siengeTituloNumber);
        if (!installments.length) throw new Error('Nenhuma parcela encontrada para o título');
        const installment = installments[0];
        const installmentId = installment.installmentNumber ?? installment.indexId ?? 1;
        await SiengeBillsService.registerBoletoPayment(launch.siengeTituloNumber, installmentId, boletoBarcode);
        console.log(`✅ [Pipeline] #${launchId}: barcode atualizado na parcela #${installmentId} do título #${launch.siengeTituloNumber}`);
    } catch (err) {
        console.error(`❌ [Pipeline] #${launchId}: falha ao atualizar barcode no Sienge: ${err.message}`);
        throw err; // propaga para o controller retornar 500 ao frontend
    }

    // 3. Anexa o novo arquivo de boleto ao título no Sienge (não-bloqueante)
    try {
        const { data: buffer } = await axios.get(boletoUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const desc = `Boleto${boletoDueDate ? ` — Vence ${boletoDueDate}` : ''}`;
        await SiengeBillsService.attachBillFile(
            launch.siengeTituloNumber,
            desc,
            Buffer.from(buffer),
            boletoFilename || 'boleto.pdf'
        );
        console.log(`📎 [Pipeline] #${launchId}: novo boleto anexado ao título #${launch.siengeTituloNumber}`);
    } catch (err) {
        // Falha no anexo não deve travar o fluxo — barcode já foi atualizado
        console.warn(`⚠️  [Pipeline] #${launchId}: falha ao anexar boleto ao título (continuando): ${err.message}`);
    }

    // 4. Avança para aguardando pagamento (ou mantém se já estava lá)
    const refreshed = await Model().findByPk(launchId, { attributes: ['id', 'pipelineStage'] });
    if (!['awaiting_titulo_authorization', 'titulo_pago'].includes(refreshed?.pipelineStage)) {
        await refreshed.update({ pipelineStage: 'awaiting_titulo_authorization' });
    }

    console.log(`✅ [Pipeline] #${launchId}: boleto atualizado com sucesso no título #${launch.siengeTituloNumber}`);
    return { success: true };
}

// ── Documento fiscal depois da medição ────────────────────────────────────────
const DOC_FIELDS = [
    'nfUrl', 'nfPath', 'nfFilename', 'nfNumber', 'nfType', 'nfIssueDate', 'nfAccessKey',
    'boletoUrl', 'boletoPath', 'boletoFilename', 'boletoBarcode', 'boletoIssueDate', 'boletoDueDate', 'boletoAmount',
];

/**
 * Recebe a nota (e o boleto) de um lançamento que mediu antes do documento.
 * Passa pelo portão; se a medição já está autorizada, gera o título na hora.
 * @returns {{ ok: boolean, motivos?: string[], tituloStarted?: boolean }}
 */
export async function stepAttachDocument(launchId, fields = {}, userId = null) {
    const launch = await loadLaunch(launchId);
    if (['cancelado', 'titulo_pago'].includes(launch.status)) {
        return { ok: false, motivos: [`Lançamento ${launch.status} não recebe documento.`] };
    }
    if (launch.siengeTituloNumber) {
        return { ok: false, motivos: [`O título #${launch.siengeTituloNumber} já foi gerado; troque o boleto pela opção de atualizar boleto.`] };
    }

    const next = {};
    for (const k of DOC_FIELDS) if (fields[k] !== undefined) next[k] = fields[k] === '' ? null : fields[k];
    if (next.nfType) next.nfType = String(next.nfType).trim().toUpperCase();

    const { receita } = await recipeOfLaunch(launch);
    const merged = { ...launch.toJSON(), ...next };
    const motivos = checkDocument(merged, receita);
    if (motivos.length) return { ok: false, motivos };

    await patch(launch, { ...next, siengeTituloError: null });

    // Medição já autorizada e esperando a nota -> título agora.
    if (launch.pipelineStage === 'awaiting_document') {
        const [changed] = await Model().update(
            { pipelineStage: 'creating_titulo' },
            { where: { id: launchId, pipelineStage: 'awaiting_document' } },
        );
        if (changed > 0) {
            stepCreateTitulo(launchId, userId || launch.createdBy).catch(err =>
                console.error(`❌ [Pipeline] #${launchId}: falha ao criar título após anexar documento: ${err.message}`),
            );
            return { ok: true, tituloStarted: true };
        }
    }
    // Ainda medindo/aguardando autorização: o poll da medição segue para o título.
    return { ok: true, tituloStarted: false };
}
