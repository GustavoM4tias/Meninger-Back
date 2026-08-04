// services/eventPlan/eventPlanService.js
//
// Núcleo do Plano de Eventos: settings, trilha de atividade, recálculo de
// totais e as regras de quem pode o quê.
//
// Alçada em três camadas (padrão único do Office):
//   1. tela  → requireRoutePermission nas rotas (fora daqui)
//   2. dado  → accessScopeService: gestor e aprovador só alcançam empreendimento
//              com grant. Fail-closed.
//   3. papel → perfil habilita DECIDIR; o grant define SOBRE QUAIS planos.

import db from '../../models/sequelize/index.js';
import { getScope } from '../permissions/accessScopeService.js';
import { PLAN_STATUS, EDITABLE_STATUSES } from '../../models/sequelize/eventPlan/eventPlan.js';
import { isStanding, isFullyApproved } from '../../models/sequelize/eventPlan/plannedEvent.js';
import { ACTIVITY } from '../../models/sequelize/eventPlan/eventPlanActivity.js';
import { DEFAULT_STAGES, DEFAULT_ITEM_CATEGORIES } from '../../models/sequelize/eventPlan/eventPlanSettings.js';

const {
    EventPlan, PlannedEvent, PlannedEventItem,
    EventPlanActivity, EventPlanAuthProfile, EventPlanSettings,
} = db;

// ── Settings (singleton lazy) ────────────────────────────────────────────────

export async function getSettings() {
    let s = await EventPlanSettings.findOne({ order: [['id', 'ASC']] });
    if (!s) {
        s = await EventPlanSettings.create({
            stages: DEFAULT_STAGES,
            item_categories: DEFAULT_ITEM_CATEGORIES,
        });
    }
    return s;
}

/** A fila de autorização, na ordem configurada. Pode ser vazia. */
export async function getStages() {
    const s = await getSettings();
    return [...(s.stages || DEFAULT_STAGES)]
        .filter(st => st && st.key)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** A etapa seguinte a `key` na fila. Null quando `key` é a última. */
export function nextStageAfter(stages, key) {
    const i = stages.findIndex(s => s.key === key);
    if (i < 0) return null;
    return stages[i + 1] || null;
}

export function findStage(stages, key) {
    return stages.find(s => s.key === key) || null;
}

// ── Papéis ───────────────────────────────────────────────────────────────────

function isAdmin(user) {
    return user?.role === 'admin';
}

/**
 * O usuário pode DECIDIR nesta etapa? Só olha o perfil — o alcance por
 * empreendimento é do canReachEnterprise (grant). As duas coisas se somam.
 */
export async function userCanDecideStage(user, stageKey) {
    if (!user?.id) return false;
    if (isAdmin(user)) return true;

    const stages = await getStages();
    const stage = stages.find(s => s.key === stageKey);
    if (!stage) return false;

    const profileIds = (stage.profile_ids || []).map(Number).filter(Boolean);
    if (!profileIds.length) return false;

    const profiles = await EventPlanAuthProfile.findAll({
        where: { id: profileIds, is_active: true },
        attributes: ['id', 'user_ids'],
    });
    return profiles.some(p => (p.user_ids || []).map(Number).includes(Number(user.id)));
}

/** Todas as etapas em que o usuário pode decidir (para montar a tela). */
export async function decidableStagesForUser(user) {
    const stages = await getStages();
    const out = [];
    for (const s of stages) {
        if (await userCanDecideStage(user, s.key)) out.push(s.key);
    }
    return out;
}

/** O empreendimento está no escopo de dados do usuário? Fail-closed. */
export async function canReachEnterprise(user, idempreendimento) {
    const scope = await getScope(user);
    if (scope.all) return true;
    return scope.cvIds.includes(Number(idempreendimento));
}

/** É gestor responsável por este plano (ou admin)? */
export function isPlanOwner(user, plan) {
    if (!user?.id || !plan) return false;
    if (isAdmin(user)) return true;
    return (plan.owner_user_ids || []).map(Number).includes(Number(user.id));
}

/**
 * O gestor pode ESCREVER neste plano agora?
 * Só o dono, e só em draft ou returned. Submetido trava até devolução — é o que
 * garante que a proposta decidida foi a proposta enviada.
 */
export function canEditPlan(user, plan) {
    if (!plan) return false;
    if (plan.status === PLAN_STATUS.CLOSED) return false; // mês fechado congela até para admin
    if (isAdmin(user)) return true;
    if (!isPlanOwner(user, plan)) return false;
    return EDITABLE_STATUSES.includes(plan.status);
}

/**
 * O plano já aprovado ainda aceita EVENTO EXTRA — a oportunidade que aparece no
 * dia 20 não pode exigir reabrir o mês inteiro. O extra nasce e é editado com o
 * plano parado em `approved`; só quando o gestor envia é que o plano volta para
 * a fila, e os eventos já decididos continuam decididos.
 */
export function canAddExtraEvent(user, plan) {
    if (!plan || plan.status !== PLAN_STATUS.APPROVED) return false;
    return isAdmin(user) || isPlanOwner(user, plan);
}

/**
 * Permissão de escrita no nível do EVENTO. Vale o plano aberto; e, no plano
 * aprovado, vale o evento extra que ainda não foi decidido.
 */
export function canEditEvent(user, plan, event) {
    if (canEditPlan(user, plan)) return true;
    if (!event?.is_extra) return false;
    if (!isUndecided(event)) return false;
    return canAddExtraEvent(user, plan);
}

/** Nenhuma etapa decidiu sobre esta linha ainda. */
export function isUndecided(row) {
    return Object.keys(row?.stage_status || {}).length === 0;
}

/** Extras aguardando envio num plano já aprovado. */
export function hasPendingExtras(events = []) {
    return events.some(e => e.is_extra && isUndecided(e));
}

// ── Envio para aprovação ─────────────────────────────────────────────────────

/**
 * Coloca o plano na fila do Comercial. Usado nos DOIS caminhos:
 *  - o gestor clicando em "Enviar" (userId preenchido, auto = false);
 *  - o envio AUTOMÁTICO no fim da janela (userId null, auto = true).
 *
 * Fica aqui, e não no controller, justamente porque o scheduler precisa do
 * mesmo comportamento — inclusive a limpeza das marcações no reenvio.
 *
 * @returns {Promise<{ok:boolean, reason?:string, events?:number}>}
 */
export async function submitPlanCore(plan, { userId = null, auto = false } = {}) {
    const events = await PlannedEvent.findAll({ where: { plan_id: plan.id } });
    // Plano sem evento nenhum não tem o que aprovar. No envio automático isso
    // não pode virar erro silencioso: devolve o motivo para quem chamou avisar.
    if (!events.length) return { ok: false, reason: 'EMPTY' };

    // Reenvio depois de devolução: o gestor pode ter mudado qualquer coisa, então
    // as marcações da rodada anterior saem e tudo volta a ser decidido do zero.
    // O histórico das decisões continua em event_plan_decisions.
    const isResubmit = plan.status === PLAN_STATUS.RETURNED;
    if (isResubmit) {
        const eventIds = events.map(e => e.id);
        await PlannedEvent.update({ stage_status: {} }, { where: { plan_id: plan.id } });
        if (eventIds.length) {
            await PlannedEventItem.update(
                { stage_status: {}, approved_value: null, needs_quote: false },
                { where: { planned_event_id: eventIds } }
            );
        }
    }

    // Sem etapa configurada não há a quem pedir autorização: enviar já aprova.
    // A tela de configuração avisa disso ao admin que deixa a fila vazia.
    const stages = await getStages();
    const first = stages[0] || null;

    await plan.update({
        status: first ? PLAN_STATUS.IN_REVIEW : PLAN_STATUS.APPROVED,
        current_stage_key: first?.key || null,
        submitted_at: new Date(),
        submitted_by: userId,
        updated_by: userId,
    });
    await recomputeTotals(plan.id);
    await logActivity({
        planId: plan.id, userId, action: ACTIVITY.PLAN_SUBMITTED,
        meta: {
            round: plan.round, events: events.length, resubmit: isResubmit, auto,
            stage: first?.name || null,
            no_stages: !first,
        },
    });

    return { ok: true, events: events.length, approvedImmediately: !first };
}

// ── Trilha ───────────────────────────────────────────────────────────────────

export async function logActivity({ planId, plannedEventId = null, itemId = null, userId = null, action, meta = null }, transaction = null) {
    return EventPlanActivity.create(
        { plan_id: planId, planned_event_id: plannedEventId, item_id: itemId, user_id: userId, action, meta },
        transaction ? { transaction } : undefined
    );
}

// ── Totais ───────────────────────────────────────────────────────────────────

const money = (v) => Math.round(Number(v || 0) * 100) / 100;

/**
 * A MATEMÁTICA dos totais, sem banco: recebe eventos, seus itens e a fila de
 * etapas, e devolve o que cada evento e o plano somam. Separada da persistência
 * de propósito — é dinheiro na tela do gestor, precisa ser testável sem subir nada.
 *
 * "Aprovado" é o que continua DE PÉ depois das etapas já decididas, não o que
 * terminou o fluxo: assim o número aparece certo logo após a primeira
 * autorização, e cai se uma etapa seguinte reprovar.
 *
 * approved_value null em item de pé significa "aprovado sem corte" e vale o proposto.
 *
 * @param {Array} events                     [{ id, stage_status }]
 * @param {Map<number, Array>} itemsByEvent  id do evento -> itens
 * @param {Array} stages                     fila de etapas configurada
 */
export function computeTotals(events, itemsByEvent, stages = []) {
    const perEvent = new Map();
    let planProposed = 0;
    let planApproved = 0;
    let eventsApproved = 0;
    let eventsRejected = 0;

    for (const ev of events) {
        const evItems = itemsByEvent.get(ev.id) || [];
        const proposed = money(evItems.reduce((s, it) => s + Number(it.proposed_value || 0), 0));
        const eventStanding = isStanding(ev, stages);

        const approved = money(evItems.reduce((s, it) => {
            if (!eventStanding || !isStanding(it, stages)) return s;
            const value = it.approved_value == null ? Number(it.proposed_value || 0) : Number(it.approved_value);
            return s + value;
        }, 0));

        perEvent.set(ev.id, { proposed, approved });

        planProposed += proposed;
        if (eventStanding) {
            eventsApproved += 1;
            planApproved += approved;
        } else {
            eventsRejected += 1;
        }
    }

    return {
        perEvent,
        totals: {
            proposed: money(planProposed),
            approved: money(planApproved),
            events_proposed: events.length,
            events_approved: eventsApproved,
            events_rejected: eventsRejected,
        },
    };
}

/**
 * Recalcula item -> evento -> plano e PERSISTE. Sempre no servidor: valor que vem
 * do front é sugestão, nunca verdade. A conta em si é do computeTotals.
 */
export async function recomputeTotals(planId, transaction = null) {
    const opts = transaction ? { transaction } : undefined;

    const events = await PlannedEvent.findAll({ where: { plan_id: planId }, ...opts });
    const eventIds = events.map(e => e.id);
    const items = eventIds.length
        ? await PlannedEventItem.findAll({ where: { planned_event_id: eventIds }, ...opts })
        : [];

    const byEvent = new Map(eventIds.map(id => [id, []]));
    for (const it of items) {
        if (byEvent.has(it.planned_event_id)) byEvent.get(it.planned_event_id).push(it);
    }

    const { perEvent, totals } = computeTotals(events, byEvent, await getStages());

    for (const ev of events) {
        const { proposed, approved } = perEvent.get(ev.id);
        if (Number(ev.proposed_total) !== proposed || Number(ev.approved_total) !== approved) {
            await ev.update({ proposed_total: proposed, approved_total: approved }, opts);
        }
    }

    await EventPlan.update({ totals }, { where: { id: planId }, ...opts });
    return totals;
}

/** Valor proposto de um item, sempre recalculado a partir de qtd × unitário. */
export function computeProposedValue({ quantity, unit_value }) {
    return money(Number(quantity || 0) * Number(unit_value || 0));
}

// ── Janela do ciclo ──────────────────────────────────────────────────────────

/**
 * O evento acontece antes do prazo de aprovação fechar? Nesse caso ele entra na
 * fila prioritária do aprovador e o gestor recebe o aviso ao cadastrar — a
 * janela vai até o dia `deadline_day` e um evento do dia 3 pode acontecer antes
 * de ser decidido.
 */
export function isInPriorityWindow(eventDate, referenceMonth, settings) {
    if (!eventDate || !referenceMonth) return false;
    const day = Number(String(eventDate).slice(8, 10));
    const sameMonth = String(eventDate).slice(0, 7) === String(referenceMonth).slice(0, 7);
    return sameMonth && day <= Number(settings?.priority_window_days || 10);
}

export default {
    getSettings, getStages, nextStageAfter, findStage,
    userCanDecideStage, decidableStagesForUser,
    canReachEnterprise, isPlanOwner, canEditPlan, canAddExtraEvent, canEditEvent,
    hasPendingExtras, logActivity, submitPlanCore,
    recomputeTotals, computeTotals, computeProposedValue, isInPriorityWindow,
    isStanding, isFullyApproved,
};
