// services/sienge/paymentFlow/modules/tituloDireto.js
//
// Módulo TÍTULO DIRETO (receita `contrato: 'nenhum'`): cria o título pela API
// do Sienge (POST /v1/bills), sem contrato, sem medição e sem Playwright. É o
// formato do RB de reembolso levantado em 01/10/2026 (RBs do Gustavo Diniz e do
// Daniel Taketa): credor PF, documento RB, número pela data (ddmmaaaa), uma
// parcela, apropriação financeira + obra + departamento, pago por PIX na chave
// CPF do próprio credor ("usar dados do credor").
//
// Ordem: confere duplicidade -> cria o título -> grava o PIX na parcela ->
// anexa o relatório -> confere pela API o que ficou gravado. Qualquer falha
// depois de criar NÃO cria de novo: o lançamento guarda o número do título e
// o reprocessamento retoma do ponto que faltou.

import axios from 'axios';
import apiSienge from '../../../../lib/apiSienge.js';
import { SiengeBillsService } from '../../SiengeBillsService.js';
import { SiengeCreditorService } from '../../SiengeCreditorService.js';
import { loadLaunch, patch, recipeOfLaunch, resolveEnterpriseIds } from '../shared.js';

import {
    PIX_PAYMENT_TYPE, onlyDigits, norm, iso, contaSemMascara, numeroPorData, montarTitulo, montarPix,
} from '../directTitle.js';

export { numeroPorData };

/** GET /v1/bills; o Sienge responde 404 quando a busca não acha nada. */
async function buscarTitulos(params) {
    try {
        const { data } = await apiSienge.get('/v1/bills', { params });
        return data?.results || [];
    } catch (err) {
        if (err.response?.status === 404) return [];
        throw err;
    }
}

// ── Item de orçamento da obra ─────────────────────────────────────────────────
// A API de orçamento responde 403 para a integração, então o código do item
// sai das apropriações de títulos já lançados na mesma obra (o nome do item é
// o mesmo em toda obra, o código muda: Marketing é 01.001.001.004 no WISH e
// 01.001.001.035 na Administração). Cache por processo.
const cacheItem = new Map();
const CODIGO_ITEM_RE = /^\d{2}(\.\d{3}){2,}$/;

export async function resolverItemOrcamento({ buildingId, nome, codigo }) {
    if (codigo && CODIGO_ITEM_RE.test(String(codigo).trim())) return { codigo: String(codigo).trim(), nome: nome || null };
    if (!nome) return null;
    const chave = `${buildingId}|${norm(nome)}`;
    if (cacheItem.has(chave)) return cacheItem.get(chave);

    const hoje = new Date();
    const desde = new Date(hoje.getTime() - 365 * 86400000);
    const titulos = (await buscarTitulos({ costCenterId: buildingId, startDate: iso(desde), endDate: iso(hoje), limit: 200 })).sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)));
    const alvo = norm(nome);
    for (const t of titulos.slice(0, 60)) {
        try {
            const { data: bc } = await apiSienge.get(`/v1/bills/${t.id}/buildings-cost`, { params: { limit: 50 } });
            const hit = (bc?.results || []).find(r => Number(r.buildingId) === Number(buildingId) && norm(r.costEstimationSheetName) === alvo);
            if (hit) {
                const achado = { codigo: hit.costEstimationSheetId, nome: hit.costEstimationSheetName, referencia: t.id };
                cacheItem.set(chave, achado);
                return achado;
            }
        } catch { /* um título ruim não para a busca */ }
    }
    return null;
}

// ── Duplicidade: mesmo credor, empresa, documento e número (ou mesmo valor no mês) ──
export async function procurarDuplicado({ creditorId, companyId, documento, numero, valor, emissao }) {
    const ini = new Date(`${emissao}T12:00:00Z`);
    const lista = await buscarTitulos({
        creditorId, debtorId: companyId,
        startDate: iso(new Date(ini.getTime() - 45 * 86400000)),
        endDate: iso(new Date(ini.getTime() + 45 * 86400000)),
        limit: 200,
    });
    const doc = String(documento).trim();
    for (const b of lista) {
        if (String(b.documentIdentificationId).trim() !== doc) continue;
        if (String(b.documentNumber).trim() === String(numero)) return { id: b.id, motivo: `já existe o título ${b.id} (${doc} ${b.documentNumber})` };
        if (Math.abs(Number(b.totalInvoiceAmount) - Number(valor)) < 0.005) {
            return { id: b.id, motivo: `já existe o título ${b.id} (${doc} ${b.documentNumber}) de R$ ${Number(b.totalInvoiceAmount).toFixed(2)} para este credor nesta empresa em ${b.issueDate}` };
        }
    }
    return null;
}

/** Acha o id do título recém-criado (o POST responde 201 sem corpo em algumas versões). */
async function acharCriado({ creditorId, companyId, documento, numero, emissao }) {
    const b = (await buscarTitulos({ creditorId, debtorId: companyId, startDate: emissao, endDate: emissao, limit: 50 })).find(x => String(x.documentIdentificationId).trim() === documento && String(x.documentNumber).trim() === String(numero));
    return b?.id || null;
}

function erroSienge(err) {
    const d = err.response?.data;
    const s = err.response?.status;
    return s ? `Sienge ${s}: ${d?.clientMessage || d?.developerMessage || JSON.stringify(d)?.slice(0, 300)}` : err.message;
}

/**
 * Plano do título direto, só leitura: resolve tudo e diz o que vai gravar.
 * Usado pela execução (que roda o plano de novo) e por quem quiser mostrar antes.
 */
export async function planDirectTitulo(launch) {
    const { receita, typeConfig } = await recipeOfLaunch(launch);
    const motivos = [];
    const avisos = [];
    const { erpId, companyId } = await resolveEnterpriseIds(launch);
    if (!erpId || !companyId) motivos.push('Empreendimento sem obra/empresa do Sienge.');

    const creditor = launch.siengeCreditorId
        ? { id: launch.siengeCreditorId, name: launch.siengeCreditorName }
        : await SiengeCreditorService.findByDocument(launch.providerCnpj);
    if (!creditor?.id) motivos.push('Credor não encontrado no Sienge.');

    const documento = receita.titulo.documento || String(launch.nfType || '').trim().toUpperCase();
    if (!documento) motivos.push('Documento do título não definido (receita do tipo ou documento do lançamento).');
    const hoje = iso(new Date());
    const emissao = String(launch.nfIssueDate || hoje).slice(0, 10);
    const vencimento = String(launch.boletoDueDate || hoje).slice(0, 10);
    if (vencimento < hoje) avisos.push(`Vencimento ${vencimento} já passou.`);
    const numero = launch.nfNumber || numeroPorData(emissao);
    const conta = launch.financialAccountNumber || typeConfig?.financialAccountNumber;
    if (!contaSemMascara(conta)) motivos.push('Conta financeira não definida no tipo nem no lançamento.');
    const departamentoId = typeConfig?.departamentoId || null;

    let item = null;
    if (erpId) {
        item = await resolverItemOrcamento({ buildingId: erpId, nome: launch.budgetItem || typeConfig?.budgetItem, codigo: launch.budgetItemCode || typeConfig?.budgetItemCode }).catch(() => null);
        if (!item) motivos.push(`Não achei o item de orçamento "${launch.budgetItem || typeConfig?.budgetItem}" na obra ${erpId}. Informe o código do item (ex.: 01.001.001.004) no lançamento.`);
    }

    let pix = null;
    if (receita.titulo.pagamento === 'pix') {
        const cpf = onlyDigits(launch.providerCnpj);
        if (cpf.length !== 11) motivos.push('PIX na chave CPF exige credor pessoa física com CPF.');
        else pix = montarPix({ nome: creditor?.name || launch.providerName, cpf });
    }

    let duplicado = null;
    if (!motivos.length && !launch.siengeTituloNumber) {
        duplicado = await procurarDuplicado({ creditorId: creditor.id, companyId, documento, numero, valor: launch.unitPrice, emissao });
        if (duplicado) motivos.push(`Possível duplicidade: ${duplicado.motivo}.`);
    }

    const titulo = motivos.length ? null : montarTitulo({
        companyId, creditorId: creditor.id, documento, numero, emissao, vencimento,
        valor: launch.unitPrice, observacao: launch.notes || `Reembolso - ${launch.providerName}`,
        buildingId: erpId, conta, departamentoId, itemOrcamento: item?.codigo,
    });
    return { ok: !motivos.length, motivos, avisos, titulo, pix, item, receita };
}

export async function stepCreateDirectTitulo(launchId) {
    let launch = await loadLaunch(launchId);
    const plano = await planDirectTitulo(launch);
    if (!plano.ok) {
        await patch(launch, { pipelineStage: 'titulo_error', status: 'erro', siengeTituloError: plano.motivos.join(' | ') });
        return { success: false, error: plano.motivos.join(' | '), motivos: plano.motivos };
    }

    await patch(launch, { pipelineStage: 'creating_titulo', status: 'titulo', siengeTituloError: null });

    // 1. Cria (só se ainda não criou numa tentativa anterior)
    let billId = launch.siengeTituloNumber ? Number(launch.siengeTituloNumber) : null;
    if (!billId) {
        try {
            const res = await apiSienge.post('/v1/bills', plano.titulo);
            billId = Number(res.data?.id) || Number(String(res.headers?.location || '').split('/').pop()) || null;
        } catch (err) {
            const msg = erroSienge(err);
            await patch(launch, { pipelineStage: 'titulo_error', status: 'erro', siengeTituloError: `Criação do título: ${msg}` });
            return { success: false, error: msg };
        }
        if (!billId) billId = await acharCriado({ creditorId: plano.titulo.creditorId, companyId: plano.titulo.debtorId, documento: plano.titulo.documentIdentificationId, numero: plano.titulo.documentNumber, emissao: plano.titulo.issueDate });
        if (!billId) {
            await patch(launch, { pipelineStage: 'titulo_error', status: 'erro', siengeTituloError: 'O Sienge aceitou o título mas não achei o número dele. Confira no Sienge antes de reprocessar (não reprocesse sem conferir: pode duplicar).' });
            return { success: false, error: 'título criado sem número' };
        }
        await patch(launch, { siengeTituloNumber: String(billId), nfNumber: launch.nfNumber || plano.titulo.documentNumber });
        console.log(`✅ [Pipeline] #${launchId}: título direto ${billId} criado`);
    }

    const pendencias = [];
    // 2. PIX na parcela
    if (plano.pix) {
        try { await apiSienge.patch(`/v1/bills/${billId}/installments/1/payment-information/pix`, plano.pix); }
        catch (err) { pendencias.push(`PIX não gravado (${erroSienge(err)})`); }
    }
    // 3. Anexo (relatório de despesas)
    if (launch.nfUrl) {
        try {
            const { data: buf } = await axios.get(launch.nfUrl, { responseType: 'arraybuffer', timeout: 30000 });
            await SiengeBillsService.attachBillFile(billId, 'Relatório de despesas', Buffer.from(buf), launch.nfFilename || 'reembolso.pdf');
        } catch (err) { pendencias.push(`anexo não enviado (${err.message})`); }
    }
    // 4. Conferência pela API
    try {
        const parc = (await SiengeBillsService.getInstallments(billId))[0];
        if (plano.pix && parc?.paymentTypeId !== PIX_PAYMENT_TYPE) pendencias.push(`parcela sem PIX (forma atual: ${parc?.paymentType || 'nenhuma'})`);
        if (parc && Math.abs(Number(parc.amount) - Number(launch.unitPrice)) > 0.005) pendencias.push(`valor da parcela R$ ${parc.amount} diferente do lançamento`);
    } catch (err) { pendencias.push(`conferência falhou (${err.message})`); }

    launch = await loadLaunch(launchId);
    await patch(launch, {
        pipelineStage: pendencias.length ? 'titulo_created' : 'awaiting_titulo_authorization',
        status: 'titulo',
        siengeTituloError: pendencias.length ? `Título ${billId} criado, mas: ${pendencias.join('; ')}.` : null,
    });
    return { success: true, tituloNumber: String(billId), pendencias };
}
