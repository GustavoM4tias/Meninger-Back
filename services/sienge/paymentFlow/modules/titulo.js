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
import { runPlaywrightPaymentInfo } from '../../../../playwright/services/paymentInfoService.js';
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
                await stepRegisterPix(launchId, { titulo: result.tituloNumber, documento: nfType });
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

// ── Forma de pagamento da parcela (Playwright) ───────────────────────────────
// A API do Sienge é só consulta (o PATCH payment-information dá 403 desde
// 01/10/2026): boleto e PIX entram pela tela do título, aba Inf. Pagamento.
// Depois a API (leitura) confere se a parcela ficou com a forma certa.
const TIPO_PAGTO = { boleto: 2, pix: 11 };
/** Baixa os arquivos (Supabase) para anexar pela tela. [{ url, nome, descricao }] */
async function baixarAnexos(lista = []) {
    const out = [];
    for (const a of lista.filter(x => x?.url)) {
        const { data } = await axios.get(a.url, { responseType: 'arraybuffer', timeout: 30000 });
        out.push({ nome: a.nome || 'anexo.pdf', descricao: a.descricao || a.nome, buffer: Buffer.from(data), mimeType: 'application/pdf' });
    }
    return out;
}

/** Nota/documento do lançamento como anexo do título (o Sienge exige ao menos um anexo). */
export function anexoDoDocumento(l) {
    if (!l.nfUrl) return [];
    const doc = [l.nfType, l.nfNumber].filter(Boolean).join(' ').trim();
    return [{ url: l.nfUrl, nome: l.nfFilename || 'documento.pdf', descricao: doc || 'Documento' }];
}

/** Boleto do lançamento como anexo do título. */
export function anexoDoBoleto(l, dueDate = null) {
    if (!l.boletoUrl) return [];
    const venc = dueDate || l.boletoDueDate;
    return [{ url: l.boletoUrl, nome: l.boletoFilename || 'boleto.pdf', descricao: `Boleto${venc ? ` - vence ${venc}` : ''}` }];
}

/**
 * Forma de pagamento (tipo), anexos e finalização da liberação, num login só.
 * Falha da forma de pagamento lança; anexo e liberação voltam em `avisoAnexo`.
 */
export async function gravarFormaPagamento(launch, { tipo = null, linhaDigitavel = '', descricao = '', userId = null, anexos = [] }) {
    const titulo = launch.siengeTituloNumber;
    const bill = await SiengeBillsService.getBill(titulo).catch(() => null);
    const parcela = (await SiengeBillsService.getInstallments(titulo))[0];
    if (tipo && !parcela) throw new Error(`Nenhuma parcela encontrada no título ${titulo}.`);
    const credentials = await getUserSiengeCredentials(userId || launch.createdBy);
    const arquivos = await baixarAnexos(anexos).catch(err => { throw new Error(`não consegui baixar o anexo do Office (${err.message})`); });
    const r = await runPlaywrightPaymentInfo({
        credentials, titulo, parcela: parcela?.installmentNumber ?? 1,
        origem: String(bill?.originId || 'ME').trim(), tipo, linhaDigitavel, descricao, anexos: arquivos,
        finalizar: launch.siengeMeasurementNumber ? {
            documentType: launch.siengeDocumentId, contractNumber: launch.siengeContractNumber,
            measurementNumber: Number(launch.siengeMeasurementNumber),
        } : null,
    });
    let paymentType = null;
    if (tipo) {
        const depois = (await SiengeBillsService.getInstallments(titulo))[0];
        if (Number(depois?.paymentTypeId) !== TIPO_PAGTO[tipo]) {
            throw new Error(`a tela foi salva, mas a parcela do título ${titulo} está como "${depois?.paymentType || 'sem forma de pagamento'}"`);
        }
        paymentType = depois.paymentType;
    }
    const avisos = [
        r.anexoErro && `Anexo não enviado ao título ${titulo}: ${r.anexoErro}`,
        r.liberacaoErro && `Liberação da medição não finalizada: ${r.liberacaoErro}`,
    ].filter(Boolean);
    const avisoAnexo = avisos.length ? avisos.join(' ') : null;
    if (avisoAnexo) console.warn(`⚠️  [Pipeline] #${launch.id}: ${avisoAnexo}`);
    return { ok: true, paymentType, anexados: r.anexos?.anexados || 0, liberacaoFinalizada: !!r.liberacao?.finalizada, avisoAnexo };
}

/**
 * Título lançado sem anexo no Sienge (o Sienge exige ao menos um, e sem ele a
 * liberação da medição não finaliza): anexa nota/boleto do Office e finaliza.
 * Usado pelo agendador para fechar sozinho o que ficou pela metade.
 */
export async function completarAnexos(launchId) {
    const launch = await loadLaunch(launchId);
    if (!launch.siengeTituloNumber) return { ok: false, motivo: 'sem título' };
    const anexos = [...anexoDoDocumento(launch), ...anexoDoBoleto(launch)];
    if (!anexos.length) return { ok: false, motivo: 'sem arquivo no Office' };
    // Arquivo por arquivo (pelo nome): título com o boleto e sem a nota também completa.
    const nomes = (await SiengeBillsService.getAttachments(launch.siengeTituloNumber))
        .map(a => String(a.name || '').toLowerCase());
    const faltam = anexos.filter(a => !nomes.includes(String(a.nome || '').toLowerCase()));
    if (!faltam.length) return { ok: true, jaTinha: true };
    const gp = await gravarFormaPagamento(launch, { anexos: faltam });
    await patch(launch, { siengeTituloError: gp.avisoAnexo || null });
    return { ok: !gp.avisoAnexo, anexados: gp.anexados, aviso: gp.avisoAnexo };
}

// ── PIX na parcela (EXCLUSIVO do RB) ──────────────────────────────────────────
// Na chave CNPJ/CPF do credor ("utilizar dados do credor"), pela tela do título.
// Outro documento com pagamento PIX fica com o aviso para escolher no Sienge.
export async function stepRegisterPix(launchId, { titulo, documento }) {
    const launch = await loadLaunch(launchId);
    const chave = String(launch.providerCnpj || '').trim();
    const manual = motivo => patch(launch, {
        siengeTituloError: `Título ${titulo} lançado sem forma de pagamento (${motivo}): selecione PIX na parcela, chave ${chave} (${launch.siengeCreditorName || launch.providerName}).`,
    });
    if (String(documento || '').toUpperCase() !== 'RB') return manual('PIX automático só para RB');
    try {
        const gp = await gravarFormaPagamento(launch, { tipo: 'pix', anexos: anexoDoDocumento(launch) });
        // Anexo/liberação pendentes: fica em titulo_created para o scheduler completar.
        if (gp.avisoAnexo) { await patch(launch, { siengeTituloError: gp.avisoAnexo }); return { ok: false, pendente: true }; }
        await patch(launch, { pipelineStage: 'awaiting_titulo_authorization', siengeTituloError: null });
        console.log(`✅ [Pipeline] #${launchId}: PIX registrado no título ${titulo}`);
        return { ok: true };
    } catch (err) {
        console.error(`❌ [Pipeline] #${launchId}: PIX não registrado: ${err.message}`);
        return manual(`falha ao registrar o PIX: ${err.message}`);
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
        const gp = await gravarFormaPagamento(launch, { tipo: 'boleto', linhaDigitavel: launch.boletoBarcode, anexos: [...anexoDoDocumento(launch), ...anexoDoBoleto(launch)] });
        if (gp.avisoAnexo) {
            // Boleto gravado, mas anexo/liberação ficaram: continua em titulo_created
            // para o scheduler (20 min) completar sozinho. Refazer o boleto é idempotente.
            await launch.update({ siengeTituloError: gp.avisoAnexo });
            return { success: false, reason: 'pendente', error: gp.avisoAnexo };
        }

        await launch.update({ pipelineStage: 'awaiting_titulo_authorization', siengeTituloError: null });
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
export async function stepUpdateBoleto(launchId, { boletoUrl, boletoPath, boletoFilename, boletoBarcode, boletoDueDate, boletoAmount }, userId = null) {
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
        // O robô entra na fila do login (pode haver outro rodando): a tela recebe
        // a resposta já, e o card mostra o andamento.
        pipelineStage: 'titulo_created',
        siengeTituloError: 'Na fila do robô: gravando o boleto e os anexos no Sienge (pode levar alguns minutos).',
    });

    gravarBoletoNoSienge(launchId, launch, { boletoUrl, boletoFilename, boletoBarcode, boletoDueDate }, userId)
        .catch(err => console.error(`❌ [Pipeline] #${launchId}: boleto em segundo plano: ${err.message}`));
    return { success: true, emFila: true };
}

async function gravarBoletoNoSienge(launchId, launch, { boletoUrl, boletoFilename, boletoBarcode, boletoDueDate }, userId) {
    // 2. Atualiza o código de barras na parcela do Sienge
    try {
        const gp = await gravarFormaPagamento(launch, {
            tipo: 'boleto', linhaDigitavel: boletoBarcode, userId,
            anexos: [...anexoDoDocumento(launch), ...anexoDoBoleto({ boletoUrl, boletoFilename }, boletoDueDate)],
        });
        if (gp.avisoAnexo) {
            // Boleto gravado; anexo/liberação pendentes: fica em titulo_created e o
            // scheduler (20 min) completa sozinho.
            await launch.update({ siengeTituloError: gp.avisoAnexo, pipelineStage: 'titulo_created' });
            return { success: true, pendente: gp.avisoAnexo };
        }
        console.log(`✅ [Pipeline] #${launchId}: boleto gravado no título #${launch.siengeTituloNumber}`);
    } catch (err) {
        console.error(`❌ [Pipeline] #${launchId}: falha ao atualizar barcode no Sienge: ${err.message}`);
        // Volta legível para a tela (antes era um 500 com HTML cru) e fica no lançamento.
        const msg = `Boleto não gravado no Sienge: ${err.message}. Os dados do boleto ficaram salvos no Office.`;
        await launch.update({ siengeTituloError: msg });
        return { success: false, error: msg };
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
