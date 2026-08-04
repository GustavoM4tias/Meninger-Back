// services/OfficeAI/EventPlanTools.js
//
// Tools da Eme para o PLANO DE EVENTOS (proposta mensal de eventos comerciais).
//
// PERMISSÃO em duas camadas, como manda o padrão:
//   1. `requiredPermissions: ['/comercial/plano-eventos']` no registerTool —
//      mesma alçada da tela, checada pelo ToolRegistry (admin bypassa);
//   2. escopo por empreendimento DENTRO de cada handler, via accessScopeService.
// Fail-closed: sem grant, nenhum plano. Args do Gemini nunca ampliam escopo —
// `empreendimento` é só filtro de texto sobre o que o usuário já podia ver.
//
// A Eme responde sobre o que foi proposto, o que foi aprovado, o que foi CORTADO
// e por quê — o corte é a informação que mais falta na conversa do dia a dia.

import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../permissions/accessScopeService.js';
import { isStanding } from '../../models/sequelize/eventPlan/plannedEvent.js';
import { registerTool } from './ToolRegistry.js';
import { getStages } from '../eventPlan/eventPlanService.js';

const PLAN_ROUTE = '/comercial/plano-eventos';

const { EventPlan, PlannedEvent, PlannedEventItem, EventPlanDecision, CvEnterprise, User } = db;

const STATUS_LABEL = {
    draft: 'Rascunho',
    in_review: 'Aguardando autorização',
    returned: 'Devolvido ao gestor para ajuste',
    approved: 'Aprovado',
    closed: 'Mês fechado',
};

// As etapas são configuráveis, então o rótulo sai da configuração, não de um
// mapa fixo no código.
function statusLabel(plan, stages) {
    if (plan.status !== 'in_review') return STATUS_LABEL[plan.status] || plan.status;
    const atual = stages.find(s => s.key === plan.current_stage_key);
    return atual ? `Aguardando ${atual.name}` : 'Aguardando autorização';
}

const normText = (v) => String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const money = (v) => Number(v || 0);

function monthLabel(reference) {
    const names = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const [year, month] = String(reference || '').split('-');
    return names[Number(month) - 1] ? `${names[Number(month) - 1]}/${year}` : String(reference || '');
}

function normalizeMonth(value) {
    const s = String(value || '').trim();
    return /^\d{4}-\d{2}/.test(s) ? `${s.slice(0, 7)}-01` : null;
}

// ─── Escopo ──────────────────────────────────────────────────────────────────

async function scopedWhere(user, extra = {}) {
    const where = { ...extra };
    const allowed = await visibleCvIds(user);
    if (allowed !== null) {
        if (!allowed.length) return null; // fail-closed: sem grant, sem dado
        where.idempreendimento = allowed;
    }
    return where;
}

const STATUS_ARG = {
    rascunho: 'draft',
    aguardando: 'in_review',
    em_autorizacao: 'in_review',
    devolvido: 'returned',
    aprovado: 'approved',
    fechado: 'closed',
};

// ─── query_event_plans ───────────────────────────────────────────────────────

async function executeQueryPlans(args = {}, user) {
    const where = await scopedWhere(user);
    if (!where) return { planos: [], total: 0, message: 'Você não tem acesso a nenhum empreendimento.' };

    const month = normalizeMonth(args.mes);
    if (month) where.reference_month = month;
    const status = STATUS_ARG[normText(args.status)];
    if (status) where.status = status;

    const plans = await EventPlan.findAll({
        where,
        include: [{ model: CvEnterprise, as: 'enterprise', attributes: ['nome', 'cidade'], required: false }],
        order: [['reference_month', 'DESC'], ['id', 'DESC']],
        limit: 120,
    });

    const filter = normText(args.empreendimento);
    const rows = filter
        ? plans.filter(p => normText(`${p.enterprise?.nome} ${p.enterprise?.cidade}`).includes(filter))
        : plans;

    const stages = await getStages();
    return {
        total: rows.length,
        planos: rows.map(p => ({
            id: p.id,
            empreendimento: p.enterprise?.nome || `Empreendimento ${p.idempreendimento}`,
            mes: monthLabel(p.reference_month),
            status: statusLabel(p, stages),
            eventos_propostos: p.totals?.events_proposed || 0,
            eventos_aprovados: p.totals?.events_approved || 0,
            valor_proposto: money(p.totals?.proposed),
            valor_aprovado: money(p.totals?.approved),
            sem_gestor_responsavel: Boolean(p.owner_unresolved),
        })),
        message: rows.length
            ? 'Valores em R$. "Aprovado" reflete as etapas já decididas — plano ainda em análise pode ter aprovado parcial.'
            : 'Nenhum plano encontrado com esses filtros.',
        context: { source: 'event_plans' },
    };
}

// ─── get_event_plan ──────────────────────────────────────────────────────────

async function executeGetPlan(args = {}, user) {
    const where = await scopedWhere(user);
    if (!where) return { error: 'Você não tem acesso a nenhum empreendimento.' };

    const month = normalizeMonth(args.mes);
    if (month) where.reference_month = month;

    const plans = await EventPlan.findAll({
        where,
        include: [{ model: CvEnterprise, as: 'enterprise', attributes: ['nome', 'cidade'], required: false }],
        order: [['reference_month', 'DESC'], ['id', 'DESC']],
    });

    const filter = normText(args.empreendimento);
    const plan = plans.find(p => normText(`${p.enterprise?.nome} ${p.enterprise?.cidade}`).includes(filter));
    if (!plan) {
        return {
            error: `Nenhum plano de eventos encontrado para "${args.empreendimento}"${month ? ` em ${monthLabel(month)}` : ''}.`,
        };
    }

    const [events, decisions, owners] = await Promise.all([
        PlannedEvent.findAll({
            where: { plan_id: plan.id },
            include: [{ model: PlannedEventItem, as: 'items' }],
            order: [['event_date', 'ASC']],
        }),
        EventPlanDecision.findAll({
            where: { plan_id: plan.id, round: plan.round },
            include: [{ model: User, as: 'user', attributes: ['username'], required: false }],
        }),
        (plan.owner_user_ids || []).length
            ? User.findAll({ where: { id: plan.owner_user_ids }, attributes: ['username'] })
            : Promise.resolve([]),
    ]);

    // Motivo por escopo: é o "por quê" que a pergunta do usuário quase sempre quer.
    const reasonByEvent = new Map();
    const reasonByItem = new Map();
    for (const d of decisions) {
        if (!d.comment) continue;
        const entry = { etapa: d.stage, decisao: d.decision, motivo: d.comment, por: d.user?.username || null };
        if (d.scope === 'EVENT') reasonByEvent.set(Number(d.scope_id), entry);
        if (d.scope === 'ITEM') reasonByItem.set(Number(d.scope_id), entry);
    }

    const stages = await getStages();
    const isApproved = (row) => isStanding(row, stages);

    return {
        empreendimento: plan.enterprise?.nome || `Empreendimento ${plan.idempreendimento}`,
        mes: monthLabel(plan.reference_month),
        status: statusLabel(plan, stages),
        gestores: owners.map(o => o.username),
        valor_proposto: money(plan.totals?.proposed),
        valor_aprovado: money(plan.totals?.approved),
        eventos: events.map(ev => ({
            titulo: ev.title,
            data: ev.event_date,
            prioridade: ev.priority,
            objetivo: ev.objective,
            extra: ev.is_extra,
            aprovado: isApproved(ev),
            situacao_por_etapa: ev.stage_status,
            motivo: reasonByEvent.get(Number(ev.id)) || null,
            ja_na_agenda: Boolean(ev.event_id),
            valor_proposto: money(ev.proposed_total),
            valor_aprovado: money(ev.approved_total),
            itens: (ev.items || []).map(item => ({
                nome: item.name,
                categoria: item.category,
                quantidade: Number(item.quantity),
                valor_proposto: money(item.proposed_value),
                valor_aprovado: item.approved_value == null ? null : money(item.approved_value),
                cortado: item.approved_value != null && money(item.approved_value) < money(item.proposed_value),
                obrigatorio: item.necessity === 'OBRIGATORIO',
                base: item.cost_basis === 'ORCADO' ? 'orçado' : 'estimativa',
                precisa_cotar: Boolean(item.needs_quote),
                fornecedor: item.supplier,
                aprovado: isApproved(item),
                motivo: reasonByItem.get(Number(item.id)) || null,
            })),
        })),
        message: 'Valores em R$. Ao falar de corte, cite SEMPRE o valor proposto, o aprovado e o motivo registrado.',
        context: { source: 'event_plans' },
    };
}

// ─── get_event_plan_agenda ───────────────────────────────────────────────────

async function executeGetAgenda(args = {}, user) {
    const month = normalizeMonth(args.mes);
    if (!month) return { error: 'Informe o mês no formato YYYY-MM.' };

    const where = await scopedWhere(user, { reference_month: month });
    if (!where) return { error: 'Você não tem acesso a nenhum empreendimento.' };

    const plans = await EventPlan.findAll({
        where,
        include: [
            { model: CvEnterprise, as: 'enterprise', attributes: ['nome'], required: false },
            { model: PlannedEvent, as: 'events', include: [{ model: PlannedEventItem, as: 'items' }] },
        ],
    });

    const stages = await getStages();
    const agenda = [];
    const byCategory = new Map();
    let proposed = 0;
    let approved = 0;

    for (const plan of plans) {
        proposed += money(plan.totals?.proposed);
        approved += money(plan.totals?.approved);

        for (const ev of plan.events || []) {
            const ok = isStanding(ev, stages);

            agenda.push({
                data: ev.event_date,
                evento: ev.title,
                empreendimento: plan.enterprise?.nome || `Empreendimento ${plan.idempreendimento}`,
                prioridade: ev.priority,
                aprovado: ok,
                valor: money(ev.approved_total || ev.proposed_total),
            });

            if (!ok) continue;
            for (const item of ev.items || []) {
                if (!isStanding(item, stages)) continue;

                const key = item.category || 'Sem categoria';
                if (!byCategory.has(key)) byCategory.set(key, { categoria: key, total: 0, quantidade: 0, itens: [] });
                const bucket = byCategory.get(key);
                const value = money(item.approved_value == null ? item.proposed_value : item.approved_value);
                bucket.total += value;
                bucket.quantidade += Number(item.quantity || 0);
                bucket.itens.push({
                    nome: item.name,
                    quantidade: Number(item.quantity),
                    valor: value,
                    empreendimento: plan.enterprise?.nome || null,
                    precisa_cotar: Boolean(item.needs_quote),
                });
            }
        }
    }

    agenda.sort((a, b) => String(a.data).localeCompare(String(b.data)));

    return {
        mes: monthLabel(month),
        total_planos: plans.length,
        total_eventos: agenda.length,
        eventos_aprovados: agenda.filter(a => a.aprovado).length,
        valor_proposto: Math.round(proposed * 100) / 100,
        valor_aprovado: Math.round(approved * 100) / 100,
        agenda,
        lista_de_compras: [...byCategory.values()].sort((a, b) => b.total - a.total),
        message: 'Valores em R$. A lista de compras soma o mesmo tipo de item entre empreendimentos — use isso para falar de volume e negociação.',
        context: { source: 'event_plans' },
    };
}

// ─── Registro (ToolRegistry — padrão obrigatório para tools novas) ───────────

// Erro na tool vira resposta legível para a Eme, não exceção que derruba o chat.
function guard(name, fn) {
    return async (user, args) => {
        try {
            return { result: await fn(args || {}, user) };
        } catch (err) {
            console.error(`[EventPlanTools] ${name}:`, err);
            return { result: { error: `Erro ao consultar planos de eventos: ${err.message}` } };
        }
    };
}

registerTool({
    name: 'query_event_plans',
    description:
        'Lista os Planos de Eventos (proposta mensal de eventos comerciais por empreendimento) visíveis ao usuário: qual empreendimento, qual mês, em que etapa está, quanto foi proposto e quanto foi aprovado. Use para "quais planos temos", "o plano do X já foi aprovado?", "quanto o comercial propôs em agosto?", "quem ainda não enviou o plano do mês". NÃO use para detalhar eventos e itens de um plano — para isso use get_event_plan.',
    parameters: {
        type: 'object',
        properties: {
            empreendimento: { type: 'string', description: 'Filtro por nome do empreendimento ou cidade. Busca parcial, sem acento.' },
            mes: { type: 'string', description: 'Mês de referência no formato YYYY-MM. Ex: "2026-08".' },
            status: { type: 'string', description: 'Filtro: "rascunho" | "aguardando_comercial" | "aguardando_marketing" | "devolvido" | "aprovado" | "fechado".' },
        },
    },
    requiredPermissions: [PLAN_ROUTE],
    contexts: ['OFFICE'],
    handler: guard('query_event_plans', executeQueryPlans),
});

registerTool({
    name: 'get_event_plan',
    description:
        'Detalha UM Plano de Eventos: cada evento proposto com data, prioridade, itens de custo, o que foi aprovado, o que foi CORTADO e o motivo de cada corte ou reprovação. Use para "o que a Helena propôs para agosto?", "por que o evento X foi reprovado?", "quanto cortaram do plano do Parque das Flores?", "quais itens ainda precisam ser cotados?". Sem `mes`, retorna o plano mais recente do empreendimento.',
    parameters: {
        type: 'object',
        properties: {
            empreendimento: { type: 'string', description: 'Nome do empreendimento ou cidade. Busca parcial, sem acento.' },
            mes: { type: 'string', description: 'Mês de referência (YYYY-MM). Omita para pegar o mais recente.' },
        },
        required: ['empreendimento'],
    },
    requiredPermissions: [PLAN_ROUTE],
    contexts: ['OFFICE'],
    handler: guard('get_event_plan', executeGetPlan),
});

registerTool({
    name: 'get_event_plan_agenda',
    description:
        'Agenda consolidada de eventos de um MÊS somando todos os empreendimentos visíveis, mais a lista de compras agrupada por categoria (o total de cada tipo de item somado entre os empreendimentos). Use para "quais eventos temos em agosto?", "quanto vamos gastar com brinde no mês?", "quantos panfletos no total?", "o que o marketing precisa providenciar?".',
    parameters: {
        type: 'object',
        properties: {
            mes: { type: 'string', description: 'Mês de referência (YYYY-MM). Obrigatório.' },
        },
        required: ['mes'],
    },
    requiredPermissions: [PLAN_ROUTE],
    contexts: ['OFFICE'],
    handler: guard('get_event_plan_agenda', executeGetAgenda),
});
