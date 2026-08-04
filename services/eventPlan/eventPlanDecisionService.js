// services/eventPlan/eventPlanDecisionService.js
//
// O motor de decisão — o que diferencia este módulo das Aprovações de Marketing.
// Lá o ticket é tudo-ou-nada; aqui o aprovador CURADORA: aprova o evento e corta
// um item, aprova o item por valor menor, reprova dois dos cinco eventos.
//
// A decisão chega em LOTE (o aprovador percorre a lista marcando e confirma uma
// vez só), roda numa transação e recalcula tudo no fim.
//
// Invariantes que o servidor garante, não a tela:
//  - comentário obrigatório em ressalva, reprovação e devolução;
//  - corte de valor É ressalva (vira APPROVED_WITH_NOTES sozinho);
//  - reprovar item OBRIGATORIO exige escolha explícita: ou o evento inteiro cai
//    junto, ou o item é reclassificado como OPCIONAL. Nunca passa calado;
//  - evento reprovado derruba todos os itens dele;
//  - nada é sobrescrito: decisão de round anterior continua gravada.

import db from '../../models/sequelize/index.js';
import { PLAN_STATUS } from '../../models/sequelize/eventPlan/eventPlan.js';
import { APPROVED_SET, stageStatusOf, isStanding } from '../../models/sequelize/eventPlan/plannedEvent.js';
import { COMMENT_REQUIRED, SCOPE } from '../../models/sequelize/eventPlan/eventPlanDecision.js';
import { NECESSITY } from '../../models/sequelize/eventPlan/plannedEventItem.js';
import { ACTIVITY } from '../../models/sequelize/eventPlan/eventPlanActivity.js';
import {
    userCanDecideStage, canReachEnterprise, logActivity, recomputeTotals,
    getStages, nextStageAfter, findStage,
} from './eventPlanService.js';

const { EventPlan, PlannedEvent, PlannedEventItem, EventPlanDecision, sequelize } = db;

const VALID_DECISIONS = ['APPROVED', 'APPROVED_WITH_NOTES', 'REJECTED', 'RETURNED'];

export class DecisionError extends Error {
    constructor(message, status = 400, details = null) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

const money = (v) => Math.round(Number(v || 0) * 100) / 100;

/** Grava o status desta etapa preservando o que as outras já decidiram. */
const withStage = (row, stageKey, status) => ({ ...(row.stage_status || {}), [stageKey]: status });

/**
 * Valida o lote ANTES de gravar qualquer coisa. Falha aqui devolve 422 com a
 * lista do que precisa ser resolvido, para a tela apontar item a item em vez de
 * dar um erro genérico.
 *
 * Pura de propósito (só dados dentro, lista de problemas fora): é onde moram as
 * regras que não podem quebrar, então precisa ser testável sem banco.
 */
export function validateBatch({ events, plannedEvents, itemsByEvent, stages = [], stageKey }) {
    // Etapas anteriores a esta na fila: quem já foi reprovado lá não volta.
    const previous = stages.slice(0, Math.max(0, stages.findIndex(s => s.key === stageKey)));
    const problems = [];

    for (const decision of events) {
        const ev = plannedEvents.get(Number(decision.id));
        if (!ev) {
            problems.push({ scope: 'EVENT', id: decision.id, error: 'Evento não pertence a este plano.' });
            continue;
        }
        if (!VALID_DECISIONS.includes(decision.decision)) {
            problems.push({ scope: 'EVENT', id: ev.id, error: 'Decisão inválida.' });
            continue;
        }
        if (COMMENT_REQUIRED.includes(decision.decision) && !String(decision.comment || '').trim()) {
            problems.push({ scope: 'EVENT', id: ev.id, error: 'Ressalva, reprovação e devolução exigem comentário.' });
        }

        // Só chega nesta etapa quem sobreviveu às anteriores.
        if (previous.length && !isStanding(ev, previous)) {
            problems.push({ scope: 'EVENT', id: ev.id, error: 'Evento não passou por uma etapa anterior.' });
        }

        const eventRejected = decision.decision === 'REJECTED';
        const known = itemsByEvent.get(ev.id) || new Map();

        for (const itemDecision of (decision.items || [])) {
            const item = known.get(Number(itemDecision.id));
            if (!item) {
                problems.push({ scope: 'ITEM', id: itemDecision.id, error: 'Item não pertence a este evento.' });
                continue;
            }
            if (!VALID_DECISIONS.includes(itemDecision.decision)) {
                problems.push({ scope: 'ITEM', id: item.id, error: 'Decisão inválida.' });
                continue;
            }

            const cutting = itemDecision.approved_value != null
                && money(itemDecision.approved_value) < money(item.proposed_value);

            if ((COMMENT_REQUIRED.includes(itemDecision.decision) || cutting)
                && !String(itemDecision.comment || '').trim()) {
                problems.push({
                    scope: 'ITEM', id: item.id,
                    error: 'Cortar valor ou reprovar exige comentário — o gestor precisa do motivo, não só do número.',
                });
            }
            if (itemDecision.approved_value != null && money(itemDecision.approved_value) < 0) {
                problems.push({ scope: 'ITEM', id: item.id, error: 'Valor aprovado não pode ser negativo.' });
            }
            if (itemDecision.approved_value != null && money(itemDecision.approved_value) > money(item.proposed_value)) {
                problems.push({
                    scope: 'ITEM', id: item.id,
                    error: 'Valor aprovado maior que o proposto. Para aumentar, devolva ao gestor com a ressalva.',
                });
            }

            // A regra do item obrigatório: sem escolha explícita, não passa.
            const rejectingRequired = itemDecision.decision === 'REJECTED'
                && item.necessity === NECESSITY.OBRIGATORIO
                && !eventRejected
                && !itemDecision.reclassify_necessity;
            if (rejectingRequired) {
                problems.push({
                    scope: 'ITEM', id: item.id, code: 'REQUIRED_ITEM_REJECTED',
                    error: `"${item.name}" é obrigatório para o evento. Reprove o evento inteiro ou reclassifique o item como opcional.`,
                });
            }
        }
    }

    return problems;
}

/**
 * Aplica um lote de decisões de UMA etapa sobre UM plano.
 *
 * @param {object} params
 * @param {object} params.user            usuário logado (req.user)
 * @param {number} params.planId
 * @param {string} params.stage           chave da etapa (event_plan_settings.stages)
 * @param {Array}  params.events          [{ id, decision, comment, items: [...] }]
 * @param {string} [params.planComment]
 * @param {boolean} [params.returnPlan]   devolve o plano inteiro ao gestor
 */
export async function applyDecisions({ user, planId, stage, events = [], planComment = null, returnPlan = false }) {
    const stages = await getStages();
    const stageDef = findStage(stages, stage);
    if (!stageDef) throw new DecisionError('Etapa de autorização inexistente.', 400);

    const plan = await EventPlan.findByPk(planId);
    if (!plan) throw new DecisionError('Plano não encontrado.', 404);
    if (plan.status === PLAN_STATUS.CLOSED) {
        throw new DecisionError('Mês fechado — o plano está congelado.', 409);
    }

    // A etapa tem que ser a que o plano está aguardando: ninguém decide fora da
    // vez nem pula a fila.
    if (plan.status !== PLAN_STATUS.IN_REVIEW || plan.current_stage_key !== stage) {
        const atual = findStage(stages, plan.current_stage_key);
        throw new DecisionError(
            atual ? `Este plano está aguardando a etapa "${atual.name}".` : 'Este plano não está aguardando decisão.',
            409
        );
    }

    // Perfil habilita decidir; grant define sobre qual empreendimento.
    if (!(await userCanDecideStage(user, stage))) {
        throw new DecisionError('Sem alçada para decidir nesta etapa.', 403);
    }
    if (!(await canReachEnterprise(user, plan.idempreendimento))) {
        throw new DecisionError('Sem acesso a este empreendimento.', 403);
    }

    const plannedEventRows = await PlannedEvent.findAll({ where: { plan_id: plan.id } });
    const plannedEvents = new Map(plannedEventRows.map(e => [Number(e.id), e]));
    const itemRows = plannedEventRows.length
        ? await PlannedEventItem.findAll({ where: { planned_event_id: plannedEventRows.map(e => e.id) } })
        : [];

    const itemsByEvent = new Map(plannedEventRows.map(e => [Number(e.id), new Map()]));
    for (const it of itemRows) {
        itemsByEvent.get(Number(it.planned_event_id))?.set(Number(it.id), it);
    }

    if (returnPlan && !String(planComment || '').trim()) {
        throw new DecisionError('Devolver ao gestor exige um comentário dizendo o que ajustar.', 400);
    }

    if (!returnPlan) {
        const problems = validateBatch({ events, plannedEvents, itemsByEvent, stages, stageKey: stage });
        if (problems.length) {
            throw new DecisionError('Há pendências na decisão.', 422, problems);
        }
    }

    const round = plan.round;
    const stageName = stageDef.name;

    return sequelize.transaction(async (transaction) => {
        const t = { transaction };

        // ── Devolução do plano inteiro ────────────────────────────────────────
        if (returnPlan) {
            await EventPlanDecision.create({
                plan_id: plan.id, scope: SCOPE.PLAN, scope_id: null, stage,
                user_id: user.id, round, decision: 'RETURNED', comment: planComment,
            }, t);
            await plan.update({
                status: PLAN_STATUS.RETURNED,
                current_stage_key: null,
                round: plan.round + 1,
                updated_by: user.id,
            }, t);
            await logActivity({
                planId: plan.id, userId: user.id, action: ACTIVITY.PLAN_RETURNED,
                meta: { stage: stageName, round, comment: planComment },
            }, transaction);
            await recomputeTotals(plan.id, transaction);
            return { status: PLAN_STATUS.RETURNED, returned: true };
        }

        // ── Decisões por evento e item ────────────────────────────────────────
        for (const decision of events) {
            const ev = plannedEvents.get(Number(decision.id));
            const eventRejected = decision.decision === 'REJECTED';

            await EventPlanDecision.create({
                plan_id: plan.id, scope: SCOPE.EVENT, scope_id: ev.id, stage,
                user_id: user.id, round, decision: decision.decision, comment: decision.comment || null,
            }, t);
            await ev.update({ stage_status: withStage(ev, stage, decision.decision), updated_by: user.id }, t);
            await logActivity({
                planId: plan.id, plannedEventId: ev.id, userId: user.id, action: ACTIVITY.EVENT_DECIDED,
                meta: { stage: stageName, round, decision: decision.decision, comment: decision.comment || null },
            }, transaction);

            const known = itemsByEvent.get(ev.id) || new Map();

            // Evento reprovado derruba os itens junto: não existe item aprovado
            // de evento que não vai acontecer.
            if (eventRejected) {
                for (const item of known.values()) {
                    await item.update({
                        stage_status: withStage(item, stage, 'REJECTED'),
                        needs_quote: false,
                        updated_by: user.id,
                    }, t);
                }
                continue;
            }

            for (const itemDecision of (decision.items || [])) {
                const item = known.get(Number(itemDecision.id));
                const proposed = money(item.proposed_value);
                const cutValue = itemDecision.approved_value == null ? null : money(itemDecision.approved_value);
                const cutting = cutValue != null && cutValue < proposed;

                // Corte de valor É ressalva, mesmo que a tela tenha mandado
                // APPROVED — o gestor precisa ver que houve corte.
                const finalDecision = cutting && itemDecision.decision === 'APPROVED'
                    ? 'APPROVED_WITH_NOTES'
                    : itemDecision.decision;

                const reclassified = Boolean(itemDecision.reclassify_necessity)
                    && item.necessity === NECESSITY.OBRIGATORIO;

                await EventPlanDecision.create({
                    plan_id: plan.id, scope: SCOPE.ITEM, scope_id: item.id, stage,
                    user_id: user.id, round, decision: finalDecision,
                    approved_value: cutValue, comment: itemDecision.comment || null,
                    reclassified_necessity: reclassified,
                }, t);

                const approvedNow = APPROVED_SET.includes(finalDecision);
                const patch = {
                    stage_status: withStage(item, stage, finalDecision),
                    updated_by: user.id,
                    // Item ESTIMADO que passou vira pendência de cotação do mkt.
                    needs_quote: approvedNow && item.cost_basis === 'ESTIMADO',
                };
                if (approvedNow) patch.approved_value = cutValue == null ? proposed : cutValue;
                if (reclassified) patch.necessity = NECESSITY.OPCIONAL;

                await item.update(patch, t);

                if (cutting) {
                    await logActivity({
                        planId: plan.id, plannedEventId: ev.id, itemId: item.id, userId: user.id,
                        action: ACTIVITY.ITEM_VALUE_CUT,
                        meta: { stage: stageName, round, from: proposed, to: cutValue, comment: itemDecision.comment || null },
                    }, transaction);
                }
                if (reclassified) {
                    await logActivity({
                        planId: plan.id, plannedEventId: ev.id, itemId: item.id, userId: user.id,
                        action: ACTIVITY.ITEM_RECLASSIFIED,
                        meta: { stage: stageName, round, from: NECESSITY.OBRIGATORIO, to: NECESSITY.OPCIONAL },
                    }, transaction);
                }
                await logActivity({
                    planId: plan.id, plannedEventId: ev.id, itemId: item.id, userId: user.id,
                    action: ACTIVITY.ITEM_DECIDED,
                    meta: { stage: stageName, round, decision: finalDecision, approved_value: cutValue },
                }, transaction);
            }
        }

        // ── Avanço na fila de etapas ──────────────────────────────────────────
        const refreshed = await PlannedEvent.findAll({ where: { plan_id: plan.id }, transaction });
        const survived = refreshed.filter(e => APPROVED_SET.includes(stageStatusOf(e, stage)));

        // Nenhum evento sobreviveu: não há o que a próxima etapa decidir. O fluxo
        // encerra aqui com aprovado zero, em vez de empurrar um plano vazio fila
        // afora.
        const next = survived.length ? nextStageAfter(stages, stage) : null;
        const nextStatus = next ? PLAN_STATUS.IN_REVIEW : PLAN_STATUS.APPROVED;

        await plan.update({
            status: nextStatus,
            current_stage_key: next?.key || null,
            // Trilha de quem fechou cada etapa, sem coluna fixa por etapa.
            stage_decisions: {
                ...(plan.stage_decisions || {}),
                [stage]: { at: new Date().toISOString(), by: user.id, name: stageName },
            },
            updated_by: user.id,
        }, t);

        if (nextStatus === PLAN_STATUS.APPROVED) {
            await logActivity({
                planId: plan.id, userId: user.id, action: ACTIVITY.PLAN_APPROVED,
                meta: { stage: stageName, round, events_approved: survived.length },
            }, transaction);
        }

        const totals = await recomputeTotals(plan.id, transaction);
        return {
            status: nextStatus,
            next_stage: next ? { key: next.key, name: next.name } : null,
            totals,
            events_approved: survived.length,
        };
    });
}

export default { applyDecisions, DecisionError };
