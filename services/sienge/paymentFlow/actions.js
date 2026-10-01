// services/sienge/paymentFlow/actions.js
//
// Ações do Fluxo de Pagamento sobre processos que JÁ EXISTEM - usadas pela Eme
// (cartão de confirmação) e pela tela. Regra: a Eme PROPÕE, VALIDA, EXPLICA e
// só age depois do clique da pessoa.
//
// Validação em três tempos (a "redobrada"):
//   1. planAction  - só lê: confere tudo no Office e no Sienge e diz o que vai
//                    acontecer. Qualquer falha = sem botão de confirmar.
//   2. executeAction - no clique, refaz o plano no servidor (o Sienge pode ter
//                    mudado; o cliente nunca manda dado que não seja revalidado).
//   3. depois de agir, confere pela API do Sienge que ficou como planejado e
//      registra no lançamento se não ficou.
//
// Ações:
//   importar_medicao  medição que existe no Sienge passa a ser acompanhada (só Office)
//   medir_no_saldo    mede no saldo do contrato existente, sem aditivo
//   gerar_titulo      libera a medição autorizada como título, com a nota
//   registrar_boleto  registra o boleto na parcela de um título sem pagamento

import axios from 'axios';
import db from '../../../models/sequelize/index.js';
import apiSienge from '../../../lib/apiSienge.js';
import { SiengeContractService, DEFAULT_BUILDING_UNIT } from '../SiengeContractService.js';
import { SiengeBillsService } from '../SiengeBillsService.js';
import { getScope, isErpAllowed } from '../../permissions/accessScopeService.js';
import { pickMeasurementItem } from './measurementItem.js';
import { checkDocument } from './gate.js';
import { recipeOf } from './recipe.js';
import { patch } from './shared.js';
import { candidateForMeasurement, createLaunchFromCandidate } from './siengeImport.js';
import { stepCreateMeasurement } from './modules/medicao.js';
import { stepCreateTitulo } from './modules/titulo.js';

export const ACOES = ['importar_medicao', 'medir_no_saldo', 'gerar_titulo', 'registrar_boleto'];

const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dia = v => { if (!v) return '-'; const [y, m, d] = String(v).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const hojeIso = () => new Date().toISOString().slice(0, 10);
const digits = s => String(s || '').replace(/\D/g, '');
const perto = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

function validador() {
    const lista = [];
    return {
        lista,
        ok: (texto) => lista.push({ nivel: 'ok', texto }),
        falha: (texto) => lista.push({ nivel: 'falha', texto }),
        aviso: (texto) => lista.push({ nivel: 'aviso', texto }),
        passou: () => !lista.some(v => v.nivel === 'falha'),
    };
}

/** Lançamento visível para a pessoa (mesma regra da listagem da tela). */
async function launchForUser(user, id) {
    const launch = await db.PaymentLaunch.findByPk(Number(id));
    if (!launch) return { launch: null, motivo: `Lançamento #${id} não existe.` };
    if (user.role === 'admin' || launch.createdBy === user.id) return { launch };
    const scope = await getScope(user);
    if (launch.enterpriseId && isErpAllowed(scope, Number(launch.enterpriseId))) return { launch };
    return { launch: null, motivo: `Você não tem acesso ao lançamento #${id}.` };
}

/**
 * Lançamento do pedido: pelo id, ou pela medição do Sienge (doc/contrato/obra/nº).
 * Medição que o Office ainda não acompanha vira um lançamento "provisório" a
 * partir do Sienge, e o plano avisa que a ação também cria o lançamento.
 * @returns {{ launch, motivo?, candidato? }}
 */
async function launchOuMedicao(user, p, v) {
    if (p.launchId) return launchForUser(user, p.launchId);
    if (!(p.documentId && p.contractNumber && p.buildingId && p.measurementNumber)) {
        return { launch: null, motivo: 'Informe o lançamento ou a medição (contrato, obra e número).' };
    }
    const [[ja]] = await db.sequelize.query(
        `SELECT id FROM payment_launches WHERE upper(sienge_document_id) = :d AND sienge_contract_number = :c
            AND enterprise_id = :b AND sienge_measurement_number = :m AND status <> 'cancelado' LIMIT 1`,
        { replacements: { d: String(p.documentId).toUpperCase(), c: String(p.contractNumber), b: Number(p.buildingId), m: Number(p.measurementNumber) } },
    );
    if (ja) return launchForUser(user, ja.id);
    const { candidato, motivos } = await candidateForMeasurement(user, p);
    if (!candidato) return { launch: null, motivo: motivos[0] };
    if (candidato.etapa === 'pago') return { launch: null, motivo: 'Esta medição já está paga.' };
    v.aviso(`A medição ${candidato.contrato} nº ${candidato.measurementNumber} ainda não está no Office: a ação também cria o lançamento (tipo ${candidato.tipo || 'Importado do Sienge'}).`);
    // Provisório com os campos que os planos leem; vira lançamento de verdade na execução.
    const launch = {
        id: null, provisorio: true, status: 'medicao', pipelineStage: null,
        providerName: candidato.fornecedor, siengeCreditorId: candidato.creditorId, enterpriseId: candidato.buildingId,
        siengeDocumentId: candidato.documentId, siengeContractNumber: candidato.contractNumber,
        siengeMeasurementNumber: candidato.measurementNumber, siengeTituloNumber: candidato.titulo?.id || null,
        nfType: candidato.titulo?.documento || null, nfNumber: candidato.titulo?.numero || null, nfIssueDate: candidato.titulo?.emissao || null,
        unitPrice: candidato.valor, launchType: candidato.tipo || 'Importado do Sienge',
        budgetItem: null, budgetItemCode: null, boletoBarcode: null, boletoDueDate: null,
        toJSON() { return { ...this }; },
    };
    return { launch, candidato };
}

/** Lançamento parado com erro: avisa qual era o erro e desde quando (não barra). */
function avisoDeErro(launch, v) {
    if (launch.status !== 'erro') return;
    const erro = launch.siengeTituloError || launch.siengeMeasurementError || launch.siengeContractError;
    const desde = launch.updatedAt ? dia(new Date(launch.updatedAt).toISOString()) : '?';
    v.aviso(`Este lançamento está parado com erro desde ${desde}${erro ? `: "${String(erro).split('\n')[0].slice(0, 160)}"` : ''}. Confira se o problema foi resolvido antes de confirmar.`);
}

/** A medição como o Sienge vê agora (inclui `released`, que o GET unitário não traz). */
async function medicaoNoSienge(doc, num, obra, med) {
    const { data } = await apiSienge.get('/v1/supply-contracts/measurements/all', {
        params: { documentId: doc, contractNumber: num, limit: 200 },
    });
    const todas = (data?.results || []).filter(m => Number(m.buildingId) === Number(obra));
    return { medicao: todas.find(m => Number(m.measurementNumber) === Number(med)) || null, todas };
}

async function taxesDoTitulo(billId) {
    const { data } = await apiSienge.get(`/v1/bills/${billId}/taxes`, { params: { limit: 50 } }).catch(() => ({ data: null }));
    return data?.results || [];
}

// ── Planos (só leitura) ────────────────────────────────────────────────────────

async function planImportar(user, p, v) {
    const { candidato, motivos, launchId } = await candidateForMeasurement(user, {
        documentId: p.documentId, contractNumber: p.contractNumber, buildingId: p.buildingId, measurementNumber: p.measurementNumber,
    });
    if (launchId) { v.falha(motivos[0]); return { alvo: `Lançamento #${launchId}`, efeitos: [] }; }
    if (!candidato) { motivos.forEach(m => v.falha(m)); return { alvo: `${p.documentId}/${p.contractNumber} nº ${p.measurementNumber}`, efeitos: [] }; }
    motivos.forEach(m => v.falha(m));
    const c = candidato;
    v.ok(`Medição ${c.contrato} nº ${c.measurementNumber} existe no Sienge (${dia(c.medicaoData)}, ${moeda(c.valor)}).`);
    v.ok(`Fornecedor: ${c.fornecedor}${c.fornecedorDoc ? ` (${c.fornecedorDoc})` : ''}.`);
    v.ok(`Etapa no Sienge: ${c.etapaLabel}${c.titulo ? ` - título ${c.titulo.id} (${c.titulo.documento} ${c.titulo.numero})` : ''}.`);
    if (c.tipo) v.ok(`Tipo de lançamento deduzido pelo item do contrato: ${c.tipo}.`);
    else v.aviso('Tipo de lançamento não identificado pelo item do contrato: entra como "Importado do Sienge".');
    if (c.observacao) v.aviso(c.observacao);
    return {
        alvo: `${c.fornecedor} - ${c.contrato} nº ${c.measurementNumber} (${c.obra})`,
        efeitos: [
            'Cria o lançamento no Fluxo de Pagamento, na etapa em que está no Sienge.',
            c.etapa === 'medicao_autorizada' ? 'Fica esperando a nota fiscal: ao anexar, o título é gerado.' : null,
            c.etapa === 'titulo_sem_boleto' ? 'O título fica marcado como "sem forma de pagamento" até o boleto ser registrado.' : null,
            'Nada é alterado no Sienge.',
        ].filter(Boolean),
        _candidato: c,
    };
}

async function planMedirNoSaldo(user, p, v) {
    const { launch, motivo } = await launchForUser(user, p.launchId);
    if (!launch) { v.falha(motivo); return { alvo: `Lançamento #${p.launchId}`, efeitos: [] }; }
    const alvo = `#${launch.id} ${launch.providerName || ''} - ${moeda(launch.unitPrice)}`;
    const valor = Number(launch.unitPrice) || 0;

    if (['cancelado', 'titulo_pago'].includes(launch.status)) v.falha(`O lançamento está ${launch.status}.`);
    avisoDeErro(launch, v);
    if (!launch.siengeDocumentId || !launch.siengeContractNumber) { v.falha('O lançamento ainda não tem contrato localizado no Sienge.'); return { alvo, efeitos: [] }; }
    if (launch.siengeMeasurementNumber) v.falha(`O lançamento já tem a medição nº ${launch.siengeMeasurementNumber}.`);
    if (!(valor > 0)) v.falha('O lançamento não tem valor.');
    if (['creating_contract', 'creating_additive', 'creating_measurement', 'creating_titulo'].includes(launch.pipelineStage)) {
        v.falha('O robô já está trabalhando neste lançamento.');
    }
    const obra = Number(launch.enterpriseId);
    const label = `${launch.siengeDocumentId}/${launch.siengeContractNumber}`;

    // Condição do contrato
    const ct = await SiengeContractService.getByIds(launch.siengeDocumentId, launch.siengeContractNumber);
    if (!ct) { v.falha(`Contrato ${label} não encontrado no Sienge.`); return { alvo, efeitos: [] }; }
    if (ct.statusApproval === 'APPROVED' && ct.isAuthorized) v.ok(`Contrato ${label} aprovado e autorizado.`);
    else v.falha(`Contrato ${label} não está aprovado e autorizado (aprovação ${ct.statusApproval || '-'}, autorizado ${ct.isAuthorized ? 'sim' : 'não'}).`);
    const hoje = hojeIso();
    if ((ct.startDate && ct.startDate > hoje) || (ct.endDate && ct.endDate < hoje)) v.falha(`Contrato fora da vigência (${dia(ct.startDate)} a ${dia(ct.endDate)}): precisa de aditivo de prazo.`);
    else v.ok(`Contrato vigente (${dia(ct.startDate)} a ${dia(ct.endDate)}).`);
    if (Array.isArray(ct.buildings) && ct.buildings.length && !ct.buildings.some(b => Number(b.buildingId) === obra)) {
        v.falha(`O contrato não tem a obra ${obra} do lançamento.`);
    }

    // Saldo do item do tipo (estrito)
    const { items } = await SiengeContractService.validateItems(launch.siengeDocumentId, launch.siengeContractNumber, obra, DEFAULT_BUILDING_UNIT, valor);
    const pick = pickMeasurementItem(items, { budgetItem: launch.budgetItem, budgetItemCode: launch.budgetItemCode, value: valor, strict: !!(launch.budgetItem || launch.budgetItemCode) });
    if (!pick.item) v.falha(pick.motivo || 'Nenhum item do contrato com saldo para este valor.');
    else v.ok(`Saldo do item "${pick.item.description}": ${moeda(pick.balance)} - cobre ${moeda(valor)}, sobram ${moeda(pick.balance - valor)}.`);
    if (pick.item && !pick.porItem) v.aviso('O item foi escolhido pelo saldo, não pelo item do tipo de lançamento: confira se é a verba certa.');

    // Medição duplicada: mesma obra/contrato, mesmo valor, ainda sem título
    const { todas } = await medicaoNoSienge(launch.siengeDocumentId, launch.siengeContractNumber, obra, 0);
    const parecidas = todas.filter(m => !m.released && perto(Number(m.totalLaborValue || 0) + Number(m.totalMaterialValue || 0), valor));
    if (parecidas.length) v.falha(`Já existe medição de ${moeda(valor)} sem título neste contrato (nº ${parecidas.map(m => m.measurementNumber).join(', ')}): pode ser a mesma conta. Importe essa medição em vez de medir de novo.`);
    else v.ok('Nenhuma medição do mesmo valor pendente neste contrato (sem risco de duplicar).');

    return {
        alvo,
        efeitos: [
            `Cria no Sienge uma medição de ${moeda(valor)} no contrato ${label}${pick.item ? `, item "${pick.item.description}"` : ''}, SEM aditivo.`,
            'A medição entra no fluxo de autorização do Sienge; autorizada, o Office pede a nota (se ainda não tiver) e gera o título.',
        ],
    };
}

async function planGerarTitulo(user, p, v) {
    const { launch, motivo, candidato } = await launchOuMedicao(user, p, v);
    if (!launch) { v.falha(motivo); return { alvo: p.launchId ? `Lançamento #${p.launchId}` : 'Medição', efeitos: [] }; }
    const alvo = launch.provisorio ? `${launch.providerName || ''}` : `#${launch.id} ${launch.providerName || ''}`;
    avisoDeErro(launch, v);
    if (launch.siengeTituloNumber) { v.falha(`O lançamento já tem o título ${launch.siengeTituloNumber}.`); return { alvo, efeitos: [] }; }
    if (!launch.siengeMeasurementNumber) { v.falha('O lançamento ainda não tem medição.'); return { alvo, efeitos: [] }; }

    const nf = {
        nfType: String(p.nf?.nfType || launch.nfType || '').trim().toUpperCase(),
        nfNumber: String(p.nf?.nfNumber || launch.nfNumber || '').trim(),
        nfIssueDate: p.nf?.nfIssueDate || launch.nfIssueDate || null,
        nfAccessKey: digits(p.nf?.nfAccessKey || launch.nfAccessKey) || null,
        nfValor: p.nf?.nfValor != null ? Number(p.nf.nfValor) : null,
        nfUrl: p.nf?.nfUrl || null, nfPath: p.nf?.nfPath || null, nfFilename: p.nf?.nfFilename || null,
    };
    if (!nf.nfNumber) v.falha('Falta o número da nota fiscal (mande o PDF da nota).');
    if (!nf.nfType) v.falha('Falta o tipo do documento (NFS, NFE...).');
    if (!nf.nfIssueDate) v.falha('Falta a data de emissão da nota.');
    else if (String(nf.nfIssueDate).slice(0, 10) > hojeIso()) v.falha(`Emissão da nota no futuro (${dia(nf.nfIssueDate)}).`);

    // Medição como o Sienge vê agora
    const label = `${launch.siengeDocumentId}/${launch.siengeContractNumber}`;
    const { medicao } = await medicaoNoSienge(launch.siengeDocumentId, launch.siengeContractNumber, launch.enterpriseId, launch.siengeMeasurementNumber);
    if (!medicao) { v.falha(`Medição ${label} nº ${launch.siengeMeasurementNumber} não encontrada no Sienge.`); return { alvo, efeitos: [] }; }
    const bruto = Number(medicao.totalLaborValue || 0) + Number(medicao.totalMaterialValue || 0);
    const liquido = Number(medicao.netValue ?? bruto);
    if (medicao.authorized) v.ok(`Medição ${label} nº ${medicao.measurementNumber} autorizada (${moeda(bruto)}${perto(bruto, liquido) ? '' : `, líquido ${moeda(liquido)}`}).`);
    else v.falha(`Medição ${label} nº ${medicao.measurementNumber} ainda não foi autorizada no Sienge.`);
    if (medicao.released) v.falha('A medição já está liberada no Sienge (já tem título): importe/atualize em vez de liberar de novo.');

    // Nota x medição
    if (nf.nfValor != null) {
        if (perto(nf.nfValor, bruto) || perto(nf.nfValor, liquido)) v.ok(`Valor da nota (${moeda(nf.nfValor)}) bate com a medição.`);
        else v.falha(`Valor da nota (${moeda(nf.nfValor)}) não bate com a medição (${moeda(bruto)}${perto(bruto, liquido) ? '' : ` / líquido ${moeda(liquido)}`}).`);
    } else {
        v.aviso('Valor da nota não informado: não deu para conferir com a medição.');
    }
    if (!perto(bruto, liquido)) v.ok(`Retenção na medição (${moeda(bruto - liquido)}): o título sai com o imposto, como nos meses anteriores.`);

    // Nota já usada em outro título do fornecedor
    if (nf.nfNumber && launch.siengeCreditorId) {
        const { bills } = await SiengeBillsService.checkPreviousLaunch({ creditorId: launch.siengeCreditorId, documentNumber: nf.nfNumber, amount: bruto, startDate: '2024-01-01', endDate: '2027-12-31' });
        const usada = (bills || []).find(b => String(b.documentNumber).trim() === nf.nfNumber);
        if (usada) v.falha(`A nota ${nf.nfNumber} já está no título ${usada.id} deste fornecedor.`);
        else v.ok(`A nota ${nf.nfNumber} ainda não foi usada em título deste fornecedor.`);
    }

    // Documento x receita do tipo
    const cfg = await db.LaunchTypeConfig.findOne({ where: { name: launch.launchType } });
    const { receita } = recipeOf(cfg);
    const docMot = checkDocument({ ...launch.toJSON(), ...nf, boletoBarcode: launch.boletoBarcode || 'x', boletoDueDate: launch.boletoDueDate || 'x' }, receita);
    docMot.forEach(m => v.falha(m));
    const depto = cfg?.departamentoId || '24';

    return {
        alvo: `${alvo} - ${label} nº ${launch.siengeMeasurementNumber}`,
        efeitos: [
            `Libera a medição no Sienge e cria o título ${nf.nfType || '?'} ${nf.nfNumber || '?'} (emissão ${dia(nf.nfIssueDate)}), departamento ${depto}.`,
            'Vencimento: o do boleto, se houver; senão hoje + 6 dias (mínimo do Sienge). Pode ajustar depois.',
            'O título fica sem forma de pagamento até o boleto ser registrado.',
            candidato ? 'Cria antes o lançamento no Fluxo de Pagamento para o Office acompanhar.' : null,
        ].filter(Boolean),
        _nf: nf,
        _candidato: candidato || null,
    };
}

async function planRegistrarBoleto(user, p, v) {
    const { launch, motivo, candidato } = await launchOuMedicao(user, p, v);
    if (!launch) { v.falha(motivo); return { alvo: p.launchId ? `Lançamento #${p.launchId}` : 'Medição', efeitos: [] }; }
    const alvo = launch.provisorio ? `${launch.providerName || ''}` : `#${launch.id} ${launch.providerName || ''}`;
    if (!launch.siengeTituloNumber) { v.falha('O lançamento ainda não tem título.'); return { alvo, efeitos: [] }; }
    const tituloId = launch.siengeTituloNumber;
    const b = {
        boletoBarcode: digits(p.boleto?.boletoBarcode),
        boletoDueDate: p.boleto?.boletoDueDate || null,
        boletoAmount: p.boleto?.boletoAmount != null ? Number(p.boleto.boletoAmount) : null,
        boletoUrl: p.boleto?.boletoUrl || null, boletoPath: p.boleto?.boletoPath || null, boletoFilename: p.boleto?.boletoFilename || null,
    };
    if (![47, 48].includes(b.boletoBarcode.length)) v.falha(`Linha digitável inválida (${b.boletoBarcode.length} dígitos; o boleto tem 47 ou 48).`);
    else v.ok('Linha digitável com tamanho válido.');

    const bill = await SiengeBillsService.getBill(tituloId);
    if (!bill) { v.falha(`Título ${tituloId} não encontrado no Sienge.`); return { alvo, efeitos: [] }; }
    const parcelas = await SiengeBillsService.getInstallments(tituloId);
    if (parcelas.length !== 1) v.falha(`O título tem ${parcelas.length} parcelas: registre pelo Sienge (o robô só trata parcela única).`);
    const parc = parcelas[0];
    if (parc?.situation === 'Totalmente paga') v.falha('O título já está pago.');
    if (parc?.paymentType) v.aviso(`A parcela já tem forma de pagamento (${parc.paymentType}): o boleto novo substitui.`);
    else if (parc) v.ok('A parcela está sem forma de pagamento (é o que trava o pagamento).');

    const taxas = await taxesDoTitulo(tituloId);
    const retido = taxas.reduce((s, t) => s + Number(t.amount || 0), 0);
    const esperado = Number(parc?.amount || bill.totalInvoiceAmount || 0) - retido;
    if (b.boletoAmount != null) {
        if (perto(b.boletoAmount, esperado, 0.05)) v.ok(`Valor do boleto (${moeda(b.boletoAmount)}) bate com o título${retido ? ` líquido de ${taxas.map(t => `${String(t.taxId).replace('.', '')} ${moeda(t.amount)}`).join(', ')}` : ''}.`);
        else v.falha(`Valor do boleto (${moeda(b.boletoAmount)}) não bate com o título (${moeda(esperado)}${retido ? ` = ${moeda(esperado + retido)} menos ${moeda(retido)} retidos` : ''}).`);
    } else v.aviso('Valor do boleto não lido: não deu para conferir com o título.');
    if (b.boletoDueDate && String(b.boletoDueDate).slice(0, 10) < hojeIso()) v.aviso(`O boleto venceu em ${dia(b.boletoDueDate)}: pode não ser aceito no banco.`);

    return {
        alvo: `${alvo} - título ${tituloId}`,
        efeitos: [
            `Registra a linha digitável na parcela do título ${tituloId} (forma de pagamento: boleto).`,
            b.boletoUrl ? 'Anexa o PDF do boleto ao título.' : null,
            candidato ? 'Cria antes o lançamento no Fluxo de Pagamento.' : null,
            'O Office passa a acompanhar até o pagamento.',
        ].filter(Boolean),
        _boleto: b,
        _candidato: candidato || null,
    };
}

const PLANOS = {
    importar_medicao: { titulo: 'Importar medição do Sienge', fn: planImportar },
    medir_no_saldo: { titulo: 'Medir no saldo do contrato', fn: planMedirNoSaldo },
    gerar_titulo: { titulo: 'Gerar o título da medição', fn: planGerarTitulo },
    registrar_boleto: { titulo: 'Registrar o boleto no título', fn: planRegistrarBoleto },
};

/**
 * Monta o plano de uma ação, SÓ LENDO. `pedido` = { acao, launchId?, documentId?,
 * contractNumber?, buildingId?, measurementNumber?, nf?, boleto? }.
 * @returns {{ acao, titulo, alvo, ok, validacoes, efeitos, pedido }}
 */
export async function planAction(user, pedido = {}) {
    const def = PLANOS[pedido.acao];
    if (!def) return { acao: pedido.acao, titulo: 'Ação desconhecida', ok: false, validacoes: [{ nivel: 'falha', texto: `Ação "${pedido.acao}" não existe.` }], efeitos: [], pedido };
    const v = validador();
    let r = {};
    try {
        r = await def.fn(user, pedido, v);
    } catch (err) {
        v.falha(`Não consegui conferir no Sienge agora (${err.message}). Nada foi feito.`);
    }
    const { _candidato, _nf, _boleto, ...pub } = r || {};
    // A medição resolvida vai no pedido: a execução refaz o plano sobre ela.
    if (_candidato && !pedido.launchId) {
        Object.assign(pedido, {
            documentId: _candidato.documentId, contractNumber: _candidato.contractNumber,
            buildingId: _candidato.buildingId, measurementNumber: _candidato.measurementNumber,
        });
    }
    return { acao: pedido.acao, titulo: def.titulo, ...pub, ok: v.passou(), validacoes: v.lista, pedido, _interno: { _candidato, _nf, _boleto } };
}

// ── Execução (depois do clique) ────────────────────────────────────────────────

async function conferirMedicao(launchId) {
    const l = await db.PaymentLaunch.findByPk(launchId);
    if (!l?.siengeMeasurementNumber) return;
    const m = await SiengeContractService.getMeasurement(l.siengeDocumentId, l.siengeContractNumber, l.enterpriseId, l.siengeMeasurementNumber).catch(() => null);
    const medido = Number(m?.measuredTotal ?? -1);
    if (!m || !perto(medido, l.unitPrice)) {
        await patch(l, { siengeMeasurementError: `Conferência: a medição nº ${l.siengeMeasurementNumber} ficou com ${moeda(medido)} no Sienge, esperado ${moeda(l.unitPrice)}. Confira antes de autorizar.` });
    }
}

async function conferirTitulo(launchId, nfNumber) {
    const l = await db.PaymentLaunch.findByPk(launchId);
    if (!l?.siengeTituloNumber) return;
    const bill = await SiengeBillsService.getBill(l.siengeTituloNumber).catch(() => null);
    if (!bill || String(bill.documentNumber).trim() !== String(nfNumber) || !perto(bill.totalInvoiceAmount, l.unitPrice)) {
        await patch(l, { siengeTituloError: `Conferência: o título ${l.siengeTituloNumber} no Sienge não bate com a nota ${nfNumber} / ${moeda(l.unitPrice)}. Confira.` });
    }
}

/**
 * Executa a ação depois do clique. Refaz o plano no servidor; falhou = 422.
 * Ações com robô rodam em segundo plano (a pessoa acompanha pela tela/Eme).
 */
export async function executeAction(user, pedido) {
    const plano = await planAction(user, pedido);
    if (!plano.ok) {
        const e = new Error(plano.validacoes.filter(x => x.nivel === 'falha').map(x => x.texto).join(' '));
        e.status = 422;
        e.plano = plano;
        throw e;
    }
    const { _candidato, _nf, _boleto } = plano._interno;

    if (pedido.acao === 'importar_medicao') {
        const launch = await createLaunchFromCandidate(user, _candidato);
        return { ok: true, launchId: launch.id, mensagem: `Lançamento #${launch.id} criado (${_candidato.etapaLabel}).` };
    }

    if (pedido.acao === 'medir_no_saldo') {
        const launchId = Number(pedido.launchId);
        const l = await db.PaymentLaunch.findByPk(launchId);
        await patch(l, { pipelineStage: 'creating_measurement', status: 'medicao', siengeContractError: null, updatedBy: user.id, updatedByName: user.username });
        stepCreateMeasurement(launchId, user.id, { strict: true })
            .then(() => conferirMedicao(launchId))
            .catch(err => console.error(`[Ação] medir_no_saldo #${launchId}: ${err.message}`));
        return { ok: true, launchId, emAndamento: true, mensagem: `Medição em andamento no Sienge para o lançamento #${launchId}.` };
    }

    // Medição que o Office ainda não acompanhava: cria o lançamento antes de agir.
    let novoId = null;
    if (['gerar_titulo', 'registrar_boleto'].includes(pedido.acao) && !pedido.launchId && _candidato) {
        novoId = (await createLaunchFromCandidate(user, _candidato)).id;
    }

    if (pedido.acao === 'gerar_titulo') {
        const launchId = Number(pedido.launchId || novoId);
        const l = await db.PaymentLaunch.findByPk(launchId);
        const campos = {
            nfType: _nf.nfType, nfNumber: _nf.nfNumber, nfIssueDate: _nf.nfIssueDate, nfAccessKey: _nf.nfAccessKey,
            ...(_nf.nfUrl && { nfUrl: _nf.nfUrl, nfPath: _nf.nfPath, nfFilename: _nf.nfFilename }),
            pipelineStage: 'creating_titulo', siengeTituloError: null, updatedBy: user.id, updatedByName: user.username,
        };
        await patch(l, campos);
        stepCreateTitulo(launchId, user.id)
            .then(() => conferirTitulo(launchId, _nf.nfNumber))
            .catch(err => console.error(`[Ação] gerar_titulo #${launchId}: ${err.message}`));
        return { ok: true, launchId, emAndamento: true, mensagem: `Título em andamento no Sienge para o lançamento #${launchId}.` };
    }

    if (pedido.acao === 'registrar_boleto') {
        const launchId = Number(pedido.launchId || novoId);
        const l = await db.PaymentLaunch.findByPk(launchId);
        const parcelas = await SiengeBillsService.getInstallments(l.siengeTituloNumber);
        const parc = parcelas[0];
        await SiengeBillsService.registerBoletoPayment(l.siengeTituloNumber, parc.installmentNumber ?? parc.indexId ?? 1, _boleto.boletoBarcode);
        if (_boleto.boletoUrl) {
            try {
                const { data: buf } = await axios.get(_boleto.boletoUrl, { responseType: 'arraybuffer', timeout: 30000 });
                await SiengeBillsService.attachBillFile(l.siengeTituloNumber, 'Boleto', Buffer.from(buf), _boleto.boletoFilename || 'boleto.pdf');
            } catch (err) { console.warn(`[Ação] anexo do boleto #${launchId}: ${err.message}`); }
        }
        await patch(l, {
            boletoBarcode: _boleto.boletoBarcode, boletoDueDate: _boleto.boletoDueDate || l.boletoDueDate,
            boletoAmount: _boleto.boletoAmount ?? l.boletoAmount,
            ...(_boleto.boletoUrl && { boletoUrl: _boleto.boletoUrl, boletoPath: _boleto.boletoPath, boletoFilename: _boleto.boletoFilename }),
            pipelineStage: 'awaiting_titulo_authorization', status: 'titulo', siengeTituloError: null,
            updatedBy: user.id, updatedByName: user.username,
        });
        // Conferência: a parcela tem forma de pagamento agora?
        const depois = (await SiengeBillsService.getInstallments(l.siengeTituloNumber))[0];
        if (!depois?.paymentType) {
            await patch(l, { siengeTituloError: 'Conferência: o Sienge aceitou o pedido, mas a parcela continua sem forma de pagamento. Confira no Sienge.' });
            return { ok: false, launchId, mensagem: 'O Sienge aceitou, mas a parcela ainda aparece sem forma de pagamento. Confira no Sienge.' };
        }
        return { ok: true, launchId, mensagem: `Boleto registrado no título ${l.siengeTituloNumber} (forma de pagamento: ${depois.paymentType}).` };
    }

    const e = new Error('Ação não executável.');
    e.status = 422;
    throw e;
}
