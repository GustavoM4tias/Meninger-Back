// services/OfficeAI/PaymentFlowActionTools.js
//
// A Eme cuidando de processos de pagamento que JÁ EXISTEM (no Office ou só no
// Sienge): enxerga, valida, propõe a próxima etapa e acompanha.
//
// REGRAS
// 1. Situação é só leitura: Office + Sienge lado a lado, sem tocar em nada.
// 2. Toda ação que grava (importar, medir no saldo, gerar título, registrar
//    boleto) vira um CARTÃO com as validações e as consequências escritas. A
//    Eme nunca executa: quem executa é o clique em Confirmar, que valida TUDO
//    de novo no servidor (paymentFlow/actions.js) e confere o resultado depois.
// 3. Escopo: o mesmo da tela - lançamentos e obras do acesso de quem pergunta.
// 4. Nota e boleto vêm dos PDFs anexados pela própria pessoa (nunca de URL do modelo).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import apiSienge from '../../lib/apiSienge.js';
import { registerTool } from './ToolRegistry.js';
import { paymentActionBlock } from './blocks.js';
import { SiengeCreditorService } from '../sienge/SiengeCreditorService.js';
import { consultarAutorizacoes } from '../sienge/paymentFlow/tituloAutorizacao.js';
import { SiengeContractService } from '../sienge/SiengeContractService.js';
import { getScope, isErpAllowed } from '../permissions/accessScopeService.js';
import { planAction, ACOES } from '../sienge/paymentFlow/actions.js';
import { anexosDaPessoa, extrair } from './PaymentLaunchTools.js';
import { ehPrevisao } from '../sienge/paymentFlow/siengeImport.js';

const ROTA = '/financeiro/paymentflow';
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const digits = s => String(s || '').replace(/\D/g, '');
const iso = d => d.toISOString().slice(0, 10);
// O validador anti-invenção da Eme só reconhece número que aparece como VALOR
// no resultado; "552952 (NFE 13618)" dentro de um texto fazia a resposta certa
// ser bloqueada ao citar a nota. Número de documento sai como número.
const numOuTexto = v => (v != null && /^\d{1,15}$/.test(String(v).trim()) ? Number(String(v).trim()) : (v ?? null));

function desligado() {
    return process.env.PAYMENT_FLOW_ENABLED !== 'true'
        ? { result: { erro: 'O Fluxo de Pagamento está desligado neste ambiente.' } }
        : null;
}

// Credores por nome: a API do Sienge ignora o filtro de nome, então a lista é
// lida uma vez e guardada (12 h). Só nome, id e documento.
let cacheCredores = { em: 0, lista: [] };
async function credoresPorNome(nome) {
    if (Date.now() - cacheCredores.em > 12 * 3600 * 1000) {
        const lista = [];
        let offset = 0;
        for (;;) {
            const { data } = await apiSienge.get('/v1/creditors', { params: { limit: 200, offset } });
            const r = data?.results || [];
            lista.push(...r.map(c => ({ id: c.id, name: c.name, tradeName: c.tradeName, cnpj: c.cnpj, cpf: c.cpf, active: c.active })));
            offset += r.length;
            if (!r.length || offset >= (data?.resultSetMetadata?.count ?? 0)) break;
        }
        cacheCredores = { em: Date.now(), lista };
    }
    const palavras = norm(nome).split(' ').filter(w => w.length > 2);
    if (!palavras.length) return [];
    return cacheCredores.lista.filter(c => palavras.every(w => norm(c.name).includes(w) || norm(c.tradeName).includes(w))).slice(0, 5);
}

async function getAll(path, params) {
    const out = [];
    let offset = 0;
    for (;;) {
        const { data } = await apiSienge.get(path, { params: { ...params, limit: 200, offset } });
        const r = data?.results || [];
        out.push(...r);
        offset += r.length;
        if (!r.length || offset >= (data?.resultSetMetadata?.count ?? 0)) break;
    }
    return out;
}

// ── Situação (só leitura) ─────────────────────────────────────────────────────
registerTool({
    name: 'lancamento_pagamento_situacao',
    description:
        'Mostra a SITUAÇÃO REAL de pagamentos de um fornecedor no Office E no Sienge (payment flow): contratos, saldo, medições '
        + '(autorizada? liberada?), títulos (vencimento, pago, forma de pagamento/boleto) e se o Office já acompanha. Só lê. '
        + 'Use para "como está o pagamento da X", "já mediram a nota Y", "o título da Z tem boleto?", antes de propor qualquer ação. '
        + 'Informe fornecedor (nome), cnpj, nota, contrato (ex.: CT/5344) ou lancamento_id; se a pessoa anexou a nota, pode deixar vazio.',
    parameters: {
        type: 'object',
        properties: {
            fornecedor: { type: 'string', description: 'Nome (ou parte) do fornecedor.' },
            cnpj: { type: 'string', description: 'CNPJ/CPF do fornecedor.' },
            nota: { type: 'string', description: 'Número da nota fiscal.' },
            contrato: { type: 'string', description: 'Contrato no formato DOC/NÚMERO, ex.: CT/5344.' },
            lancamento_id: { type: 'number', description: 'Número do lançamento no Office.' },
        },
    },
    requiredPermissions: [ROTA],
    contexts: ['OFFICE'],
    async handler(user, args = {}, runtime = {}) {
        const off = desligado();
        if (off) return off;
        const scope = await getScope(user);

        // Office: lançamentos visíveis que casam com o pedido
        const where = {};
        if (user.role !== 'admin') {
            where[Op.or] = [{ createdBy: user.id }, ...(scope.erpIds.length ? [{ enterpriseId: { [Op.in]: scope.erpIds.map(String) } }] : [])];
        }
        const filtros = [];
        if (Number(args.lancamento_id) > 0) filtros.push({ id: Number(args.lancamento_id) });
        if (args.nota) filtros.push({ nfNumber: String(args.nota).trim() });
        if (args.fornecedor) filtros.push({ providerName: { [Op.iLike]: `%${args.fornecedor}%` } }, { siengeCreditorName: { [Op.iLike]: `%${args.fornecedor}%` } });
        if (args.cnpj) filtros.push({ providerCnpj: digits(args.cnpj) });
        if (args.contrato) {
            const [d, n] = String(args.contrato).toUpperCase().split('/');
            if (d && n) filtros.push({ siengeDocumentId: d, siengeContractNumber: n });
        }
        const office = filtros.length ? await db.PaymentLaunch.findAll({
            where: { ...where, [Op.and]: [{ [Op.or]: filtros }] }, order: [['createdAt', 'DESC']], limit: 30,
        }) : [];

        // Sienge: credor por CNPJ, por lançamento, por nota anexada ou por nome
        let credores = [];
        const doc = digits(args.cnpj);
        if (doc) { const c = await SiengeCreditorService.findByDocument(doc); if (c) credores = [c]; }
        if (!credores.length) {
            const ids = [...new Set(office.map(l => l.siengeCreditorId).filter(Boolean))];
            for (const id of ids.slice(0, 3)) { const { data } = await apiSienge.get(`/v1/creditors/${id}`).catch(() => ({ data: null })); if (data) credores.push(data); }
        }
        if (!credores.length) {
            const anexos = await anexosDaPessoa(user, runtime);
            for (const a of anexos.slice(0, 2)) {
                const l = await extrair(a);
                const d2 = digits(l?.dados?.providerCnpj);
                if (d2) { const c = await SiengeCreditorService.findByDocument(d2); if (c) { credores = [c]; break; } }
            }
        }
        if (!credores.length && args.fornecedor) credores = await credoresPorNome(args.fornecedor);
        if (!credores.length && !office.length) {
            return { result: { erro: 'Não encontrei esse fornecedor nem no Office nem no Sienge. Peça o CNPJ, o nome completo ou a nota em PDF.' } };
        }

        const hoje = new Date();
        const medicoes = [];
        for (const cr of credores.slice(0, 2)) {
            const contratos = (await SiengeContractService.findAllBySupplierId(cr.id)).filter(c =>
                !args.contrato || `${c.documentId}/${c.contractNumber}`.toUpperCase() === String(args.contrato).toUpperCase());
            const bills = await getAll('/v1/bills', {
                creditorId: cr.id, startDate: iso(new Date(hoje.getTime() - 730 * 86400000)), endDate: iso(new Date(hoje.getTime() + 365 * 86400000)),
            }).catch(() => []);
            for (const ct of contratos.slice(0, 6)) {
                const meds = await getAll('/v1/supply-contracts/measurements/all', { documentId: ct.documentId, contractNumber: ct.contractNumber }).catch(() => []);
                for (const m of meds) {
                    if (!isErpAllowed(scope, Number(m.buildingId))) continue;
                    const titulo = bills.find(b => b.originId === 'ME' && !ehPrevisao(b) && String(b.contractNumber) === String(m.contractNumber) && Number(b.measurementNumber) === Number(m.measurementNumber));
                    let parcelas = [];
                    if (titulo) parcelas = await getAll(`/v1/bills/${titulo.id}/installments`, {}).catch(() => []);
                    const pago = parcelas.length > 0 && parcelas.every(p => p.situation === 'Totalmente paga');
                    const noOffice = office.find(l => String(l.siengeDocumentId).toUpperCase() === String(m.documentId).toUpperCase()
                        && String(l.siengeContractNumber) === String(m.contractNumber) && Number(l.siengeMeasurementNumber) === Number(m.measurementNumber));
                    medicoes.push({
                        fornecedor: cr.name, contrato: `${m.documentId}/${m.contractNumber}`, obra: m.buildingId, medicao: m.measurementNumber,
                        data: m.measurementDate, valor: Number(m.totalLaborValue || 0) + Number(m.totalMaterialValue || 0), liquido: m.netValue,
                        autorizada: m.authorized === true, liberada: m.released === true,
                        titulo: titulo ? titulo.id : null,
                        titulo_documento: titulo ? String(titulo.documentIdentificationId).trim() : null,
                        nota: titulo ? numOuTexto(titulo.documentNumber) : null,
                        vencimento: parcelas.find(p => p.situation !== 'Totalmente paga')?.dueDate || parcelas[0]?.dueDate || null,
                        pago, sem_forma_pagamento: !!titulo && parcelas.some(p => !p.paymentType),
                        lancamento_office: noOffice ? noOffice.id : null,
                        contrato_vigencia: `${ct.startDate} a ${ct.endDate}`, contrato_autorizado: ct.isAuthorized === true,
                    });
                }
            }
        }

        // Autorização do pagamento (parcela) dos títulos em aberto: uma consulta
        // só na API (backup D-1 se ela falhar). O status S/N do título é
        // consistência, não autorização.
        const auts = await consultarAutorizacoes(medicoes.filter(m => m.titulo && !m.pago).map(m => m.titulo)).catch(() => new Map());
        for (const m of medicoes) {
            const a = m.titulo && !m.pago ? auts.get(Number(m.titulo)) : null;
            if (!a) continue;
            m.pagamento_autorizado = a.autorizado;
            m.pagamento_autorizado_por = a.autorizacoes.map(x => `${x.nome} (${String(x.data || '').slice(0, 10)})`);
            if (a.fonte === 'backup') m.autorizacao_fonte = 'backup do Sienge (dia anterior)';
        }

        // Próxima etapa sugerida para o que está aberto
        // A pendência que TRAVA o pagamento vem primeiro; acompanhar no Office
        // (importar) é complemento, nunca esconde a pendência real.
        for (const m of medicoes) {
            const passos = [];
            if (m.pago) passos.push('nada: pago');
            else {
                if (!m.autorizada) passos.push('aguardar a autorização da medição no Sienge');
                else if (!m.titulo) passos.push(`gerar_titulo (precisa da nota em PDF)${m.lancamento_office ? ` no lançamento ${m.lancamento_office}` : ''}`);
                else if (m.sem_forma_pagamento) passos.push(`registrar_boleto: o título ${m.titulo} está SEM forma de pagamento e não será pago assim (precisa do boleto em PDF)`);
                else if (m.pagamento_autorizado === false) passos.push(`aguardar a autorização do pagamento do título ${m.titulo} no Sienge`);
                else passos.push('aguardar o pagamento');
                if (!m.lancamento_office) passos.push(`importar_medicao (contrato ${m.contrato}, obra ${m.obra}, medição ${m.medicao}) para o Office acompanhar`);
            }
            m.proxima = passos.join('; depois ');
        }
        const abertas = medicoes.filter(m => !m.pago).sort((a, b) => String(b.data).localeCompare(String(a.data)));
        const pagasRecentes = medicoes.filter(m => m.pago).sort((a, b) => String(b.data).localeCompare(String(a.data))).slice(0, 3);

        return {
            result: {
                office: office.map(l => ({
                    id: l.id, tipo: l.launchType, fornecedor: l.providerName, valor: l.unitPrice, etapa: l.pipelineStage, status: l.status,
                    contrato: l.siengeContractNumber ? `${l.siengeDocumentId}/${l.siengeContractNumber}` : null,
                    medicao: l.siengeMeasurementNumber, titulo: l.siengeTituloNumber, nf: numOuTexto(l.nfNumber),
                    pagamento_autorizado: l.siengeTituloNumber ? (l.siengeTituloAuthorized ?? undefined) : undefined,
                    erro: l.siengeTituloError || l.siengeMeasurementError || l.siengeContractError || null,
                })),
                sienge_abertas: abertas,
                sienge_pagas_recentes: pagasRecentes,
                message: 'Situação lida (nada foi alterado). Para CADA item aberto diga: contrato e número da medição, valor, '
                    + 'vencimento, e a próxima etapa de `proxima` na ordem - se o título está sem forma de pagamento, diga com '
                    + 'destaque que ele não será pago sem o boleto. Cite contrato, obra e medição para a pessoa poder pedir a ação. '
                    + 'Para agir, use lancamento_pagamento_propor - ela monta um cartão de confirmação; nunca diga que fez algo.',
            },
        };
    },
});

// ── Propor ação (cartão de confirmação) ───────────────────────────────────────
registerTool({
    name: 'lancamento_pagamento_propor',
    description:
        'MONTA um cartão de confirmação para avançar um pagamento que JÁ EXISTE (payment flow / Sienge), com todas as validações: '
        + 'importar_medicao (passar a acompanhar uma medição do Sienge), medir_no_saldo (medir no saldo do contrato, sem aditivo), '
        + 'gerar_titulo (liberar a medição autorizada com a nota anexada), registrar_boleto (registrar o boleto anexado num título sem pagamento). '
        + 'NÃO executa nada: a ação só acontece se a pessoa clicar em Confirmar no cartão. Nunca diga que fez. '
        + 'Rode lancamento_pagamento_situacao antes para saber o lançamento/contrato/medição certos.',
    parameters: {
        type: 'object',
        properties: {
            acao: { type: 'string', enum: ACOES, description: 'Ação a propor.' },
            lancamento_id: { type: 'number', description: 'Lançamento do Office. Sem ele, gerar_titulo/registrar_boleto/importar_medicao usam a medição do Sienge (contrato+obra+medicao, ou fornecedor+medicao).' },
            contrato: { type: 'string', description: 'Contrato DOC/NÚMERO da medição, ex.: CT/5344. Opcional se informar fornecedor.' },
            obra: { type: 'number', description: 'Obra/centro de custo da medição (importar_medicao), ex.: 80001. Opcional.' },
            medicao: { type: 'number', description: 'Número da medição no Sienge.' },
            fornecedor: { type: 'string', description: 'Nome do fornecedor: com o número da medição, a tool acha o contrato.' },
        },
        required: ['acao'],
    },
    requiredPermissions: [ROTA],
    contexts: ['OFFICE'],
    async handler(user, args = {}, runtime = {}) {
        const off = desligado();
        if (off) return off;
        const pedido = { acao: args.acao, launchId: args.lancamento_id || null };
        // Sem lançamento do Office: a ação vale para a medição do Sienge (importar,
        // ou gerar título/registrar boleto já criando o lançamento).
        if (!args.lancamento_id && ['importar_medicao', 'gerar_titulo', 'registrar_boleto'].includes(args.acao)) {
            let [d, n] = String(args.contrato || '').toUpperCase().split('/');
            let obra = Number(args.obra) || null;
            // Sem contrato/obra: acha pela medição entre os contratos do fornecedor.
            if ((!d || !n || !obra) && args.medicao && args.fornecedor) {
                const scope = await getScope(user);
                const achados = [];
                for (const cr of (await credoresPorNome(args.fornecedor)).slice(0, 3)) {
                    for (const ct of await SiengeContractService.findAllBySupplierId(cr.id)) {
                        if (d && n && (ct.documentId !== d || String(ct.contractNumber) !== n)) continue;
                        const meds = await getAll('/v1/supply-contracts/measurements/all', { documentId: ct.documentId, contractNumber: ct.contractNumber }).catch(() => []);
                        for (const m of meds) {
                            if (Number(m.measurementNumber) !== Number(args.medicao)) continue;
                            if (obra && Number(m.buildingId) !== obra) continue;
                            if (!isErpAllowed(scope, Number(m.buildingId))) continue;
                            achados.push({ d: m.documentId, n: String(m.contractNumber), obra: Number(m.buildingId), data: m.measurementDate, valor: m.totalLaborValue });
                        }
                    }
                }
                if (achados.length === 1) ({ d, n, obra } = achados[0]);
                else if (achados.length > 1) {
                    return { result: { erro: 'Mais de um contrato do fornecedor tem essa medição. Pergunte qual.', opcoes: achados.map(a => `${a.d}/${a.n} obra ${a.obra} (${a.data}, R$ ${a.valor})`) } };
                } else {
                    return { result: { erro: `Não achei a medição ${args.medicao} nos contratos de "${args.fornecedor}" do seu acesso.` } };
                }
            }
            Object.assign(pedido, { documentId: d, contractNumber: n, buildingId: obra, measurementNumber: args.medicao });
        }

        // Nota / boleto dos anexos da própria pessoa
        if (args.acao === 'gerar_titulo' || args.acao === 'registrar_boleto') {
            const lidos = await Promise.all((await anexosDaPessoa(user, runtime)).map(extrair));
            const nf = lidos.find(l => l.tipo === 'nf');
            const bol = lidos.find(l => l.tipo === 'boleto');
            if (args.acao === 'gerar_titulo' && nf) {
                const t = String(nf.dados.nfType || '').toUpperCase().replace(/[^A-Z]/g, '');
                pedido.nf = {
                    nfType: t.startsWith('NFS') ? 'NFS' : t === 'NFE' || t === 'DANFE' ? 'NFE' : t.slice(0, 10),
                    nfNumber: nf.dados.nfNumber, nfIssueDate: nf.dados.documentDate, nfAccessKey: nf.dados.nfAccessKey,
                    nfValor: nf.dados.unitPrice, nfUrl: nf.anexo.url, nfPath: nf.anexo.path, nfFilename: nf.anexo.fileName,
                };
            }
            if (args.acao === 'registrar_boleto' && bol) {
                pedido.boleto = {
                    boletoBarcode: bol.dados.boletoBarcode, boletoDueDate: bol.dados.boletoDueDate, boletoAmount: bol.dados.boletoAmount,
                    boletoUrl: bol.anexo.url, boletoPath: bol.anexo.path, boletoFilename: bol.anexo.fileName,
                };
            }
        }

        const { _interno, ...plano } = await planAction(user, pedido);
        return {
            result: {
                blocks: [paymentActionBlock({ plano })],
                message: plano.ok
                    ? 'O cartão JÁ está na tela com a ação validada. NADA foi feito: diga o que vai acontecer em 1-2 frases e peça para a pessoa conferir e clicar em Confirmar.'
                    : 'As validações BARRARAM esta ação e NADA foi feito. Explique os motivos do cartão e o que falta (ex.: mandar a nota/boleto, autorizar a medição).',
            },
        };
    },
});
