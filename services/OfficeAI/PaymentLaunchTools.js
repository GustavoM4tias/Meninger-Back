// services/OfficeAI/PaymentLaunchTools.js
//
// A Eme preparando lançamentos do Fluxo de Pagamento (Sienge) a partir dos
// PDFs que a pessoa manda no chat.
//
// AS REGRAS, TODAS ELAS
//
// 1. A EME NÃO LANÇA. `lancamento_pagamento_preparar` lê os anexos, monta o
//    rascunho e devolve o CARTÃO com a prévia. Quem cria o lançamento é o
//    clique em "Confirmar" (rota /sienge/payment-flow/eme/confirm), que roda o
//    portão de regras DE NOVO no servidor e cria pelo mesmo caminho da tela.
//
// 2. MESMO PORTÃO DA TELA. A prévia é paymentFlow/preview.js: tipo ativo,
//    receita (contrato existente, CTPJ, credor PJ...), NF duplicada, escopo de
//    empreendimento, credor e contrato consultados no Sienge. O que a tela
//    recusaria, o cartão mostra recusado e o botão não aparece.
//
// 3. ANEXO SÓ DO PRÓPRIO USUÁRIO. Os arquivos vêm do runtime (streamChat já
//    filtrou a pasta office/eme-chat/<id do usuário>/) ou, se foram mandados
//    num turno anterior, da listagem dessa mesma pasta na última hora. Nunca
//    de URL vinda do modelo.
//
// 4. TIPO VEM DA LISTA. O modelo escolhe o tipo pelo nome; nome fora da lista
//    ativa não vira lançamento - a tool devolve a lista.

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { paymentLaunchBlock } from './blocks.js';
import { PaymentExtractorService } from '../../validatorAI/src/services/PaymentExtractorService.js';
import { EnterpriseResolverService } from '../sienge/EnterpriseResolverService.js';
import { previewLaunch } from '../sienge/paymentFlow/preview.js';
import { recipeOf, stepsOf } from '../sienge/paymentFlow/recipe.js';
import { getScope, isErpAllowed } from '../permissions/accessScopeService.js';

const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';
const ROTA = '/financeiro/paymentflow';
const JANELA_ANEXO_MS = 60 * 60 * 1000;

// Import tardio: o cliente do Supabase lança na importação sem SUPABASE_URL, e
// este arquivo entra no OfficeChatService - que é importado por quase tudo.
const storage = async () => (await import('../../config/supabaseClient.js')).default.storage.from(BUCKET);

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

function desligado() {
    return process.env.PAYMENT_FLOW_ENABLED !== 'true'
        ? { result: { erro: 'O Fluxo de Pagamento está desligado neste ambiente.' } }
        : null;
}

/** Anexos do turno; sem eles, os PDFs que a pessoa mandou na última hora. */
export async function anexosDaPessoa(user, runtime) {
    const prefixo = `office/eme-chat/${user.id}/`;
    const doTurno = (runtime?.attachments || []).filter(a => a.path?.startsWith(prefixo));
    if (doTurno.length) return doTurno;

    const bucket = await storage();
    const { data, error } = await bucket
        .list(`office/eme-chat/${user.id}`, { limit: 10, sortBy: { column: 'created_at', order: 'desc' } });
    if (error || !Array.isArray(data)) return [];
    const agora = Date.now();
    return data
        .filter(f => f.name?.toLowerCase().endsWith('.pdf'))
        .filter(f => agora - new Date(f.created_at || 0).getTime() < JANELA_ANEXO_MS)
        .slice(0, 5)
        .map(f => {
            const p = `${prefixo}${f.name}`;
            return { path: p, fileName: f.name.replace(/^\d+-/, ''), url: bucket.getPublicUrl(p).data?.publicUrl || null };
        });
}

/** Baixa pelo storage (não por URL) e roda o mesmo extrator da tela. */
export async function extrair(anexo) {
    const { data, error } = await (await storage()).download(anexo.path);
    if (error || !data) return { anexo, erro: `Não consegui abrir ${anexo.fileName}.` };
    const tmp = path.join(os.tmpdir(), `eme-pf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    try {
        await fs.writeFile(tmp, Buffer.from(await data.arrayBuffer()));
        const r = await PaymentExtractorService.extractFromPdf(tmp, 'auto');
        if (r.error || !r.extracted) return { anexo, erro: `Não consegui ler ${anexo.fileName}: ${r.error || 'sem dados'}` };
        return r.detectedMode === 'boleto'
            ? { anexo, tipo: 'boleto', dados: PaymentExtractorService.buildBoletoPrefill(r.extracted) }
            : { anexo, tipo: 'nf', dados: PaymentExtractorService.buildNfPrefill(r.extracted) };
    } finally {
        fs.unlink(tmp).catch(() => {});
    }
}

async function tiposAtivos() {
    const rows = await db.LaunchTypeConfig.findAll({ where: { active: true }, order: [['name', 'ASC']] });
    return rows.map(t => ({ row: t, name: t.name, passos: stepsOf(recipeOf(t).receita).map(s => s.label) }));
}

function acharTipo(tipos, nome) {
    const n = norm(nome);
    if (!n) return null;
    return tipos.find(t => norm(t.name) === n)
        || tipos.find(t => norm(t.name).startsWith(n))
        || tipos.find(t => norm(t.name).includes(n))
        || null;
}

function docTypeFromNf(v) {
    const s = norm(v).replace(/[^A-Z]/g, '');
    if (!s) return null;
    if (s === 'NFE' || s === 'DANFE') return 'NFE';
    if (s.startsWith('NFS')) return 'NFS';
    if (s === 'RECIBO') return 'RB';
    return s.slice(0, 10);
}

// ── Preparar (cartão) ─────────────────────────────────────────────────────────
registerTool({
    name: 'lancamento_pagamento_preparar',
    description:
        'PREPARA um lançamento de pagamento no Sienge (Fluxo de Pagamento / payment flow) a partir da NF e do boleto em PDF '
        + 'que a pessoa anexou no chat: lê os documentos, confere as regras do tipo e mostra um CARTÃO para a pessoa conferir. '
        + 'NÃO lança nada: o lançamento só acontece quando a pessoa clica em Confirmar no cartão. Nunca diga que lançou, subiu '
        + 'ou registrou. Use quando pedirem para lançar/subir título, salário PJ, premiação, nota, boleto no Sienge. '
        + 'Se o portão recusar, explique os motivos do cartão. Sem anexo, peça a NF e o boleto em PDF pelo clipe do chat.',
    parameters: {
        type: 'object',
        properties: {
            tipo: { type: 'string', description: 'Nome do tipo de lançamento, ex.: "Salário PJ (Gestor)", "Premiação", "Marketing". Se não souber, deixe vazio que a tool devolve a lista.' },
            empreendimento: { type: 'string', description: 'Empreendimento/obra do lançamento, se a pessoa disse (senão a tool usa o que a NF indicar).' },
            valor: { type: 'number', description: 'Valor, só se a pessoa informou um valor diferente do da nota.' },
            observacao: { type: 'string', description: 'Observação livre para o lançamento (ex.: "salário 09/2026").' },
        },
    },
    requiredPermissions: [ROTA],
    contexts: ['OFFICE'],
    async handler(user, args = {}, runtime = {}) {
        const off = desligado();
        if (off) return off;

        const tipos = await tiposAtivos();
        const tipo = acharTipo(tipos, args.tipo);
        if (!tipo) {
            return {
                result: {
                    erro: args.tipo ? `Não existe tipo de lançamento "${args.tipo}".` : 'Preciso saber o tipo do lançamento.',
                    tipos_validos: tipos.map(t => ({ tipo: t.name, passos: t.passos })),
                    message: 'Pergunte à pessoa qual destes tipos é o lançamento. Nada foi lançado.',
                },
            };
        }

        const anexos = await anexosDaPessoa(user, runtime);
        if (!anexos.length) {
            return {
                result: {
                    erro: 'Nenhum PDF anexado. Peça para a pessoa mandar a nota fiscal (e o boleto, se for pago por boleto) em PDF pelo clipe do chat.',
                    tipo: tipo.name,
                    passos: tipo.passos,
                },
            };
        }

        const lidos = await Promise.all(anexos.map(extrair));
        const nf = lidos.find(l => l.tipo === 'nf');
        const boleto = lidos.find(l => l.tipo === 'boleto');
        const falhas = lidos.filter(l => l.erro).map(l => l.erro);
        const n = nf?.dados || {};
        const b = boleto?.dados || {};

        // Empreendimento: o que a pessoa disse > dica da nota. Só do escopo dela.
        let ent = null;
        const nomeEnt = args.empreendimento || n.enterpriseHint || null;
        const candidatos = [];
        if (nomeEnt) {
            const { best, candidates } = await EnterpriseResolverService.resolveByName(nomeEnt);
            const scope = await getScope(user);
            const permitidos = (candidates || []).filter(c => c.erpId && isErpAllowed(scope, c.erpId));
            ent = best && permitidos.find(c => c.erpId === best.erpId) ? best : permitidos[0] || null;
            candidatos.push(...permitidos.slice(0, 5).map(c => c.name));
        }

        const draft = {
            launchType: tipo.name,
            providerName: n.providerName || b.providerName || null,
            providerCnpj: n.providerCnpj || b.providerCnpj || null,
            enterpriseId: ent?.erpId || null,
            enterpriseName: ent?.name || nomeEnt || null,
            companyId: ent?.companyId || null,
            unitPrice: Number(args.valor) > 0 ? Number(args.valor) : (n.unitPrice || b.boletoAmount || null),
            nfType: docTypeFromNf(n.nfType),
            nfNumber: n.nfNumber || null,
            nfIssueDate: n.documentDate || null,
            nfAccessKey: n.nfAccessKey || null,
            nfUrl: nf?.anexo.url || null,
            nfPath: nf?.anexo.path || null,
            nfFilename: nf?.anexo.fileName || null,
            boletoUrl: boleto?.anexo.url || null,
            boletoPath: boleto?.anexo.path || null,
            boletoFilename: boleto?.anexo.fileName || null,
            boletoBarcode: b.boletoBarcode || null,
            boletoIssueDate: b.documentDate || null,
            boletoDueDate: b.boletoDueDate || null,
            boletoAmount: b.boletoAmount || null,
            notes: args.observacao ? String(args.observacao).slice(0, 500) : null,
        };

        // Valor da nota x boleto: diferença é sinal de documento trocado.
        const avisoExtra = [];
        if (n.unitPrice && b.boletoAmount && Math.abs(Number(n.unitPrice) - Number(b.boletoAmount)) > 0.01) {
            avisoExtra.push(`Valor da nota (R$ ${Number(n.unitPrice).toFixed(2)}) diferente do boleto (R$ ${Number(b.boletoAmount).toFixed(2)}).`);
        }
        if (!ent && nomeEnt) avisoExtra.push(`Não achei o empreendimento "${nomeEnt}" entre os liberados para você.`);
        if (!nomeEnt) avisoExtra.push('A nota não indica o empreendimento; pergunte qual é.');

        const preview = await previewLaunch(draft, user);
        preview.avisos.push(...falhas, ...avisoExtra);

        const block = paymentLaunchBlock({ draft: preview.draft, preview });
        return {
            result: {
                blocks: [block],
                message: preview.ok
                    ? 'O cartão JÁ está na tela com o lançamento pronto para conferir. NADA foi lançado: diga à pessoa para conferir e clicar em Confirmar. Comente em 1-2 frases os avisos, se houver.'
                    : 'O portão de regras RECUSOU este lançamento e NADA foi lançado. Explique os motivos do cartão em poucas frases e diga o que a pessoa precisa corrigir.',
                empreendimentos_possiveis: candidatos.length > 1 ? candidatos : undefined,
            },
        };
    },
});

// ── Acompanhar ────────────────────────────────────────────────────────────────
const ETAPAS = {
    idle: 'Aguardando início', searching_creditor: 'Buscando credor', creditor_not_found: 'Credor não cadastrado (RID)',
    searching_contract: 'Buscando contrato', contract_found: 'Contrato localizado', contract_rejected: 'Contrato recusado pelo portão',
    gate_blocked: 'Recusado pelo portão de regras', creating_contract: 'Criando contrato', contract_created: 'Contrato criado',
    contract_error: 'Erro no contrato', creating_additive: 'Criando aditivo', additive_error: 'Erro no aditivo',
    awaiting_authorization: 'Aguardando autorização do contrato', items_ok: 'Saldo conferido', items_insufficient: 'Saldo insuficiente',
    creating_measurement: 'Criando medição', measurement_error: 'Erro na medição',
    awaiting_measurement_authorization: 'Aguardando autorização da medição', awaiting_document: 'Aguardando a nota fiscal',
    creating_titulo: 'Criando título', titulo_created: 'Título criado', titulo_error: 'Erro no título',
    awaiting_titulo_authorization: 'Título lançado no Sienge, não pago', titulo_pago: 'Pago', aborted: 'Interrompido',
    contract_manual_block: 'Contrato manual - verificar',
};

// Autorização do pagamento no Sienge (parcela), lida da API ao vivo pelo
// agendador; 'backup' = veio do espelho D-1 porque a API falhou.
function autorizacaoDoTitulo(r) {
    if (!r.siengeTituloNumber || r.siengeTituloAuthorized == null) return undefined;
    const a = r.siengeTituloAuthorization || {};
    return {
        autorizado: !!r.siengeTituloAuthorized,
        situacao: r.siengeTituloAuthorized ? 'Autorizado, aguardando pagamento' : 'Aguardando autorização do pagamento',
        autorizado_por: (a.autorizacoes || []).map(x => `${x.nome} (${String(x.data || '').slice(0, 10)})`),
        fonte: a.fonte === 'backup' ? 'backup do Sienge (dia anterior)' : 'Sienge ao vivo',
        consultado_em: a.consultadoEm || null,
    };
}

registerTool({
    name: 'lancamento_pagamento_acompanhar',
    description:
        'Mostra em que etapa estão os lançamentos do Fluxo de Pagamento (payment flow / Sienge) da pessoa: fornecedor, contrato, '
        + 'medição, título, pago, e o erro quando houver. Use para "como está meu lançamento", "já subiu o salário?", "deu erro?".',
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'number', description: 'Número do lançamento, se a pessoa citou.' },
            limite: { type: 'number', description: 'Quantos lançamentos recentes (padrão 5, máx 20).' },
        },
    },
    requiredPermissions: [ROTA],
    contexts: ['OFFICE'],
    async handler(user, args = {}) {
        const off = desligado();
        if (off) return off;
        const where = {};
        // Mesma visibilidade da tela: admin vê tudo; os demais, os próprios e os
        // do escopo de empreendimento.
        if (user.role !== 'admin') {
            const scope = await getScope(user);
            where[Op.or] = [
                { createdBy: user.id },
                ...(scope.erpIds.length ? [{ enterpriseId: { [Op.in]: scope.erpIds.map(String) } }] : []),
            ];
        }
        if (Number(args.id) > 0) where.id = Number(args.id);
        const limite = Math.min(Math.max(Number(args.limite) || 5, 1), 20);
        const rows = await db.PaymentLaunch.findAll({
            where, order: [['createdAt', 'DESC']], limit: limite,
            attributes: ['id', 'launchType', 'providerName', 'enterpriseName', 'unitPrice', 'nfNumber', 'status', 'pipelineStage',
                'siengeDocumentId', 'siengeContractNumber', 'siengeMeasurementNumber', 'siengeTituloNumber',
                'siengeContractError', 'siengeMeasurementError', 'siengeTituloError', 'origin', 'createdAt',
                'siengeTituloAuthorized', 'siengeTituloAuthorization'],
        });
        return {
            result: rows.map(r => ({
                id: r.id, tipo: r.launchType, fornecedor: r.providerName, empreendimento: r.enterpriseName,
                valor: r.unitPrice, nf: r.nfNumber != null && /^\d{1,15}$/.test(String(r.nfNumber).trim()) ? Number(r.nfNumber) : r.nfNumber, etapa: ETAPAS[r.pipelineStage] || r.pipelineStage, status: r.status,
                contrato: r.siengeContractNumber ? `${r.siengeDocumentId}/${r.siengeContractNumber}` : null,
                medicao: r.siengeMeasurementNumber, titulo: r.siengeTituloNumber,
                autorizacao_pagamento: autorizacaoDoTitulo(r),
                erro: r.siengeTituloError || r.siengeMeasurementError || r.siengeContractError || null,
                via_eme: r.origin === 'eme', criado_em: r.createdAt,
            })),
            resultIds: rows.map(r => r.id),
        };
    },
});
