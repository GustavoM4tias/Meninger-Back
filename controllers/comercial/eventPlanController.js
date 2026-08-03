// controllers/comercial/eventPlanController.js
//
// Plano de Eventos — planejamento mensal de eventos comerciais.
// Alçada de TELA fica no router (requireRoutePermission); aqui valem o escopo de
// dados (grant de empreendimento) e o papel no fluxo (dono edita, perfil decide).

import db from '../../models/sequelize/index.js';
import { getScope } from '../../services/permissions/accessScopeService.js';
import { PLAN_STATUS } from '../../models/sequelize/eventPlan/eventPlan.js';
import { APPROVED_SET } from '../../models/sequelize/eventPlan/plannedEvent.js';
import { ACTIVITY } from '../../models/sequelize/eventPlan/eventPlanActivity.js';
import { NECESSITY, COST_BASIS } from '../../models/sequelize/eventPlan/plannedEventItem.js';
import { PRIORITY } from '../../models/sequelize/eventPlan/plannedEvent.js';
import { resolveOwnersForEnterprise } from '../../services/eventPlan/eventPlanOwnerService.js';
import { applyDecisions, DecisionError } from '../../services/eventPlan/eventPlanDecisionService.js';
import { publishApprovedEvents } from '../../services/eventPlan/eventPlanAgendaService.js';
import * as notifier from '../../services/eventPlan/eventPlanNotifier.js';
import * as svc from '../../services/eventPlan/eventPlanService.js';

const {
    EventPlan, PlannedEvent, PlannedEventItem, EventPlanDecision,
    EventPlanActivity, EventPlanAuthProfile, CvEnterprise, User,
} = db;

const isAdmin = (req) => req.user?.role === 'admin';

// Normaliza qualquer entrada de mês para o dia 1 ('2026-09' e '2026-09-14' viram
// '2026-09-01'). O plano é sempre do mês inteiro.
function normalizeMonth(value) {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}/.test(s)) return null;
    return `${s.slice(0, 7)}-01`;
}

async function loadPlanOr404(id, res) {
    const plan = await EventPlan.findByPk(id);
    if (!plan) {
        res.status(404).json({ error: 'Plano não encontrado.' });
        return null;
    }
    return plan;
}

// Guard de escopo: sem grant no empreendimento do plano, nem existe para o user.
async function assertReach(req, res, plan) {
    if (await svc.canReachEnterprise(req.user, plan.idempreendimento)) return true;
    res.status(403).json({ error: 'Sem acesso a este empreendimento.' });
    return false;
}

// ── Permissões do usuário atual (a tela monta a partir daqui) ────────────────

export const getMyPermissions = async (req, res) => {
    try {
        const stages = await svc.decidableStagesForUser(req.user);
        const scope = await getScope(req.user);
        res.json({
            isAdmin: isAdmin(req),
            decidableStages: stages,
            canDecide: stages.length > 0,
            enterpriseCount: scope.all ? null : scope.cvIds.length,
        });
    } catch (e) {
        console.error('[eventPlan] getMyPermissions', e?.message);
        res.status(500).json({ error: 'Falha ao carregar permissões.' });
    }
};

// ── Listagem ─────────────────────────────────────────────────────────────────

export const listPlans = async (req, res) => {
    try {
        const { Op } = db.Sequelize;
        const { reference_month, idempreendimento, status, mine } = req.query;

        const where = {};
        const month = normalizeMonth(reference_month);
        if (month) where.reference_month = month;
        if (idempreendimento) where.idempreendimento = Number(idempreendimento);
        if (status) where.status = String(status).split(',');

        // Fail-closed: sem grant, lista vazia. Nunca 500, nunca dado alheio.
        const scope = await getScope(req.user);
        if (!scope.all) {
            if (!scope.cvIds.length) return res.json([]);
            where.idempreendimento = where.idempreendimento
                ? (scope.cvIds.includes(Number(where.idempreendimento)) ? where.idempreendimento : -1)
                : scope.cvIds;
        }

        const plans = await EventPlan.findAll({
            where,
            include: [{ model: CvEnterprise, as: 'enterprise', attributes: ['idempreendimento', 'nome'], required: false }],
            order: [['reference_month', 'DESC'], ['id', 'DESC']],
            limit: 300,
        });

        let rows = plans;
        // "mine": só os planos em que o usuário é responsável (visão do gestor).
        if (String(mine) === '1' && !isAdmin(req)) {
            rows = plans.filter(p => (p.owner_user_ids || []).map(Number).includes(Number(req.user.id)));
        }

        res.json(rows.map(p => ({
            id: p.id,
            idempreendimento: p.idempreendimento,
            enterprise_name: p.enterprise?.nome || null,
            reference_month: p.reference_month,
            status: p.status,
            round: p.round,
            owner_user_ids: p.owner_user_ids,
            owner_unresolved: p.owner_unresolved,
            totals: p.totals,
            submitted_at: p.submitted_at,
            closed_at: p.closed_at,
        })));
    } catch (e) {
        console.error('[eventPlan] listPlans', e?.message);
        res.status(500).json({ error: 'Falha ao listar planos.' });
    }
};

// ── Consolidado do mês ───────────────────────────────────────────────────────

/**
 * Visão do mês inteiro: agenda unificada de todos os empreendimentos no escopo
 * e a LISTA DE COMPRAS agrupada por categoria.
 *
 * É o ganho concreto para o Marketing: em vez de olhar cinco planos separados,
 * vê "5.000 panfletos somando dois empreendimentos" e negocia junto.
 */
export const getConsolidated = async (req, res) => {
    try {
        const month = normalizeMonth(req.query?.reference_month);
        if (!month) return res.status(400).json({ error: 'Informe o mês de referência.' });

        const where = { reference_month: month };
        const scope = await getScope(req.user);
        if (!scope.all) {
            if (!scope.cvIds.length) return res.json({ month, plans: [], agenda: [], shopping: [], totals: {} });
            where.idempreendimento = scope.cvIds;
        }

        const plans = await EventPlan.findAll({
            where,
            include: [
                { model: CvEnterprise, as: 'enterprise', attributes: ['idempreendimento', 'nome'], required: false },
                { model: PlannedEvent, as: 'events', include: [{ model: PlannedEventItem, as: 'items' }] },
            ],
            order: [['idempreendimento', 'ASC']],
        });

        const agenda = [];
        const byCategory = new Map();
        let proposed = 0;
        let approved = 0;

        for (const plan of plans) {
            proposed += Number(plan.totals?.proposed || 0);
            approved += Number(plan.totals?.approved || 0);

            for (const ev of plan.events || []) {
                const eventApproved = APPROVED_SET.includes(ev.comercial_status)
                    && (APPROVED_SET.includes(ev.marketing_status) || ev.marketing_status === 'PENDING');

                agenda.push({
                    planned_event_id: ev.id,
                    plan_id: plan.id,
                    enterprise_name: plan.enterprise?.nome || null,
                    title: ev.title,
                    event_date: ev.event_date,
                    priority: ev.priority,
                    approved: eventApproved,
                    comercial_status: ev.comercial_status,
                    marketing_status: ev.marketing_status,
                    event_id: ev.event_id,
                    proposed_total: ev.proposed_total,
                    approved_total: ev.approved_total,
                });

                // A lista de compras só considera o que está de pé: item de
                // evento reprovado não vira negociação.
                if (!eventApproved) continue;
                for (const item of ev.items || []) {
                    const itemOk = APPROVED_SET.includes(item.comercial_status)
                        && (APPROVED_SET.includes(item.marketing_status) || item.marketing_status === 'PENDING');
                    if (!itemOk) continue;

                    const key = item.category || 'Sem categoria';
                    if (!byCategory.has(key)) byCategory.set(key, { category: key, total: 0, quantity: 0, items: [] });
                    const bucket = byCategory.get(key);
                    const value = Number(item.approved_value == null ? item.proposed_value : item.approved_value);
                    bucket.total += value;
                    bucket.quantity += Number(item.quantity || 0);
                    bucket.items.push({
                        name: item.name,
                        quantity: item.quantity,
                        value,
                        supplier: item.supplier,
                        needs_quote: item.needs_quote,
                        enterprise_name: plan.enterprise?.nome || null,
                        event_title: ev.title,
                        event_date: ev.event_date,
                    });
                }
            }
        }

        agenda.sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
        const shopping = [...byCategory.values()].sort((a, b) => b.total - a.total);

        res.json({
            month,
            plans: plans.map(p => ({
                id: p.id,
                idempreendimento: p.idempreendimento,
                enterprise_name: p.enterprise?.nome || null,
                status: p.status,
                totals: p.totals,
            })),
            agenda,
            shopping,
            totals: {
                proposed: Math.round(proposed * 100) / 100,
                approved: Math.round(approved * 100) / 100,
                plans: plans.length,
                events: agenda.length,
                events_approved: agenda.filter(a => a.approved).length,
                pending_quotes: shopping.flatMap(s => s.items).filter(i => i.needs_quote).length,
            },
        });
    } catch (e) {
        console.error('[eventPlan] getConsolidated', e?.message);
        res.status(500).json({ error: 'Falha ao montar o consolidado do mês.' });
    }
};

/**
 * Itens previstos de um evento da agenda. Consumido pela tela de Eventos
 * (/marketing/events), que não conhece o Plano de Eventos: devolve só a leitura
 * do que foi aprovado, sem nada de decisão.
 */
export const getByAgendaEvent = async (req, res) => {
    try {
        const plannedEvent = await PlannedEvent.findOne({
            where: { event_id: Number(req.params.eventId) },
            include: [{ model: PlannedEventItem, as: 'items' }],
        });
        if (!plannedEvent) return res.json(null);

        const plan = await EventPlan.findByPk(plannedEvent.plan_id);
        if (!plan || !(await svc.canReachEnterprise(req.user, plan.idempreendimento))) {
            return res.json(null);
        }

        const items = (plannedEvent.items || [])
            .filter(i => APPROVED_SET.includes(i.comercial_status) && APPROVED_SET.includes(i.marketing_status))
            .map(i => ({
                name: i.name,
                category: i.category,
                quantity: i.quantity,
                value: Number(i.approved_value == null ? i.proposed_value : i.approved_value),
                supplier: i.supplier,
                needs_quote: i.needs_quote,
            }));

        res.json({
            plan_id: plan.id,
            reference_month: plan.reference_month,
            priority: plannedEvent.priority,
            objective: plannedEvent.objective,
            approved_total: plannedEvent.approved_total,
            items,
        });
    } catch (e) {
        console.error('[eventPlan] getByAgendaEvent', e?.message);
        res.status(500).json({ error: 'Falha ao carregar os itens previstos.' });
    }
};

// ── Detalhe ──────────────────────────────────────────────────────────────────

export const getPlan = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        const settings = await svc.getSettings();
        const events = await PlannedEvent.findAll({
            where: { plan_id: plan.id },
            include: [{ model: PlannedEventItem, as: 'items' }],
            order: [['event_date', 'ASC'], ['position', 'ASC'], ['id', 'ASC']],
        });

        const [enterprise, activities, decisions] = await Promise.all([
            CvEnterprise.findByPk(plan.idempreendimento, { attributes: ['idempreendimento', 'nome'] }),
            EventPlanActivity.findAll({
                where: { plan_id: plan.id },
                include: [{ model: User, as: 'actor', attributes: ['id', 'username'], required: false }],
                order: [['created_at', 'DESC']],
                limit: 400,
            }),
            EventPlanDecision.findAll({
                where: { plan_id: plan.id },
                include: [{ model: User, as: 'user', attributes: ['id', 'username'], required: false }],
                order: [['created_at', 'ASC']],
            }),
        ]);

        const owners = (plan.owner_user_ids || []).length
            ? await User.findAll({ where: { id: plan.owner_user_ids }, attributes: ['id', 'username', 'email'] })
            : [];

        res.json({
            ...plan.toJSON(),
            enterprise_name: enterprise?.nome || null,
            owners,
            events: events.map(ev => ({
                ...ev.toJSON(),
                // A fila prioritária do aprovador: evento que acontece antes do
                // prazo de aprovação fechar sobe para o topo da tela.
                priority_window: svc.isInPriorityWindow(ev.event_date, plan.reference_month, settings),
            })),
            activities,
            decisions,
            can_edit: svc.canEditPlan(req.user, plan),
            // Plano aprovado ainda aceita evento extra — a tela mostra o botão
            // sem liberar a edição do que já foi decidido.
            can_add_extra: svc.canAddExtraEvent(req.user, plan),
            has_pending_extras: svc.hasPendingExtras(events),
            decidable_stages: await svc.decidableStagesForUser(req.user),
        });
    } catch (e) {
        console.error('[eventPlan] getPlan', e?.message);
        res.status(500).json({ error: 'Falha ao carregar o plano.' });
    }
};

// ── Criação do plano ─────────────────────────────────────────────────────────

export const createPlan = async (req, res) => {
    try {
        const idempreendimento = Number(req.body?.idempreendimento);
        const month = normalizeMonth(req.body?.reference_month);
        if (!idempreendimento || !month) {
            return res.status(400).json({ error: 'Informe empreendimento e mês de referência.' });
        }
        if (!(await svc.canReachEnterprise(req.user, idempreendimento))) {
            return res.status(403).json({ error: 'Sem acesso a este empreendimento.' });
        }

        const existing = await EventPlan.findOne({ where: { idempreendimento, reference_month: month } });
        if (existing) {
            return res.status(409).json({ error: 'Já existe plano para este empreendimento neste mês.', id: existing.id });
        }

        // Responsável vem da Ficha Comercial. Quem abre o plano manualmente
        // entra junto na lista: seria absurdo criar um plano e não poder editar
        // porque a ficha aponta para outra pessoa. A abertura automática (F3)
        // usa só os gestores da ficha.
        const resolved = await resolveOwnersForEnterprise(idempreendimento);
        const owners = [...new Set([...resolved.userIds, Number(req.user.id)])];

        const plan = await EventPlan.create({
            idempreendimento,
            reference_month: month,
            owner_user_ids: owners,
            owner_source: 'ficha',
            owner_unresolved: resolved.unresolved,
            status: PLAN_STATUS.DRAFT,
            created_by: req.user.id,
            updated_by: req.user.id,
            totals: { proposed: 0, approved: 0, events_proposed: 0, events_approved: 0, events_rejected: 0 },
        });

        await svc.logActivity({
            planId: plan.id, userId: req.user.id, action: ACTIVITY.PLAN_CREATED,
            meta: {
                reference_month: month,
                owners_from_ficha: resolved.userIds,
                condition_id: resolved.conditionId,
                external_managers: resolved.externalNames,
            },
        });

        res.status(201).json(plan);
    } catch (e) {
        console.error('[eventPlan] createPlan', e?.message);
        res.status(500).json({ error: 'Falha ao criar o plano.' });
    }
};

// ── Eventos do plano ─────────────────────────────────────────────────────────

function sanitizeEventPayload(body) {
    const priority = Object.values(PRIORITY).includes(body?.priority) ? body.priority : PRIORITY.IMPORTANTE;
    return {
        title: String(body?.title || '').trim(),
        kind: body?.kind ? String(body.kind).trim() : null,
        event_date: body?.event_date || null,
        event_end_date: body?.event_end_date || null,
        priority,
        objective: body?.objective ? String(body.objective) : null,
        expected_audience: body?.expected_audience != null ? Number(body.expected_audience) : null,
    };
}

export const createEvent = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        // Evento extra: incluído depois do plano aprovado. Nasce e é editado com
        // o plano parado em `approved`; só o envio o joga na fila, e os eventos
        // já decididos continuam decididos.
        const isExtra = plan.status === PLAN_STATUS.APPROVED;
        if (!svc.canEditPlan(req.user, plan) && !svc.canAddExtraEvent(req.user, plan)) {
            return res.status(403).json({ error: 'Plano não está aberto para edição.' });
        }

        const payload = sanitizeEventPayload(req.body);
        if (!payload.title || !payload.event_date) {
            return res.status(400).json({ error: 'Informe ao menos título e data do evento.' });
        }

        const created = await PlannedEvent.create({
            ...payload,
            plan_id: plan.id,
            is_extra: isExtra,
            created_by: req.user.id,
            updated_by: req.user.id,
        });

        await svc.logActivity({
            planId: plan.id, plannedEventId: created.id, userId: req.user.id,
            action: ACTIVITY.EVENT_CREATED, meta: { title: created.title, is_extra: isExtra },
        });
        await svc.recomputeTotals(plan.id);

        const settings = await svc.getSettings();
        res.status(201).json({
            ...created.toJSON(),
            priority_window: svc.isInPriorityWindow(created.event_date, plan.reference_month, settings),
        });
    } catch (e) {
        console.error('[eventPlan] createEvent', e?.message);
        res.status(500).json({ error: 'Falha ao criar o evento.' });
    }
};

export const updateEvent = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        const ev = await PlannedEvent.findOne({ where: { id: req.params.eventId, plan_id: plan.id } });
        if (!ev) return res.status(404).json({ error: 'Evento não encontrado neste plano.' });
        if (!svc.canEditEvent(req.user, plan, ev)) {
            return res.status(403).json({ error: 'Este evento não está aberto para edição.' });
        }

        const payload = sanitizeEventPayload({ ...ev.toJSON(), ...req.body });
        await ev.update({ ...payload, updated_by: req.user.id });

        await svc.logActivity({
            planId: plan.id, plannedEventId: ev.id, userId: req.user.id,
            action: ACTIVITY.EVENT_UPDATED, meta: { title: ev.title },
        });
        res.json(ev);
    } catch (e) {
        console.error('[eventPlan] updateEvent', e?.message);
        res.status(500).json({ error: 'Falha ao atualizar o evento.' });
    }
};

export const deleteEvent = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        const ev = await PlannedEvent.findOne({ where: { id: req.params.eventId, plan_id: plan.id } });
        if (!ev) return res.status(404).json({ error: 'Evento não encontrado neste plano.' });
        if (!svc.canEditEvent(req.user, plan, ev)) {
            return res.status(403).json({ error: 'Este evento não está aberto para edição.' });
        }

        const title = ev.title;
        await PlannedEventItem.destroy({ where: { planned_event_id: ev.id } });
        await ev.destroy();

        await svc.logActivity({
            planId: plan.id, userId: req.user.id, action: ACTIVITY.EVENT_DELETED, meta: { title },
        });
        await svc.recomputeTotals(plan.id);
        res.json({ ok: true });
    } catch (e) {
        console.error('[eventPlan] deleteEvent', e?.message);
        res.status(500).json({ error: 'Falha ao excluir o evento.' });
    }
};

// ── Itens do evento ──────────────────────────────────────────────────────────

function sanitizeItemPayload(body) {
    const quantity = Number(body?.quantity ?? 1);
    const unit_value = Number(body?.unit_value ?? 0);
    return {
        name: String(body?.name || '').trim(),
        category: body?.category ? String(body.category) : null,
        description: body?.description ? String(body.description) : null,
        quantity: Number.isFinite(quantity) ? quantity : 1,
        unit_value: Number.isFinite(unit_value) ? unit_value : 0,
        necessity: Object.values(NECESSITY).includes(body?.necessity) ? body.necessity : NECESSITY.OPCIONAL,
        cost_basis: Object.values(COST_BASIS).includes(body?.cost_basis) ? body.cost_basis : COST_BASIS.ESTIMADO,
        supplier: body?.supplier ? String(body.supplier) : null,
        attachment_url: body?.attachment_url ? String(body.attachment_url) : null,
    };
}

export const createItem = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        const ev = await PlannedEvent.findOne({ where: { id: req.params.eventId, plan_id: plan.id } });
        if (!ev) return res.status(404).json({ error: 'Evento não encontrado neste plano.' });
        if (!svc.canEditEvent(req.user, plan, ev)) {
            return res.status(403).json({ error: 'Este evento não está aberto para edição.' });
        }

        const payload = sanitizeItemPayload(req.body);
        if (!payload.name) return res.status(400).json({ error: 'Informe o nome do item.' });

        const item = await PlannedEventItem.create({
            ...payload,
            planned_event_id: ev.id,
            proposed_value: svc.computeProposedValue(payload),
            created_by: req.user.id,
            updated_by: req.user.id,
        });

        await svc.logActivity({
            planId: plan.id, plannedEventId: ev.id, itemId: item.id, userId: req.user.id,
            action: ACTIVITY.ITEM_CREATED,
            meta: { name: item.name, proposed_value: item.proposed_value, necessity: item.necessity },
        });
        await svc.recomputeTotals(plan.id);
        res.status(201).json(item);
    } catch (e) {
        console.error('[eventPlan] createItem', e?.message);
        res.status(500).json({ error: 'Falha ao criar o item.' });
    }
};

export const updateItem = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        const item = await PlannedEventItem.findByPk(req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Item não encontrado.' });
        const ev = await PlannedEvent.findOne({ where: { id: item.planned_event_id, plan_id: plan.id } });
        if (!ev) return res.status(404).json({ error: 'Item não pertence a este plano.' });
        if (!svc.canEditEvent(req.user, plan, ev)) {
            return res.status(403).json({ error: 'Este evento não está aberto para edição.' });
        }

        const payload = sanitizeItemPayload({ ...item.toJSON(), ...req.body });
        const before = { proposed_value: item.proposed_value, necessity: item.necessity };

        await item.update({
            ...payload,
            proposed_value: svc.computeProposedValue(payload),
            updated_by: req.user.id,
        });

        await svc.logActivity({
            planId: plan.id, plannedEventId: ev.id, itemId: item.id, userId: req.user.id,
            action: ACTIVITY.ITEM_UPDATED,
            meta: { before, after: { proposed_value: item.proposed_value, necessity: item.necessity } },
        });
        await svc.recomputeTotals(plan.id);
        res.json(item);
    } catch (e) {
        console.error('[eventPlan] updateItem', e?.message);
        res.status(500).json({ error: 'Falha ao atualizar o item.' });
    }
};

export const deleteItem = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        const item = await PlannedEventItem.findByPk(req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Item não encontrado.' });
        const ev = await PlannedEvent.findOne({ where: { id: item.planned_event_id, plan_id: plan.id } });
        if (!ev) return res.status(404).json({ error: 'Item não pertence a este plano.' });
        if (!svc.canEditEvent(req.user, plan, ev)) {
            return res.status(403).json({ error: 'Este evento não está aberto para edição.' });
        }

        const name = item.name;
        await item.destroy();

        await svc.logActivity({
            planId: plan.id, plannedEventId: ev.id, userId: req.user.id,
            action: ACTIVITY.ITEM_DELETED, meta: { name },
        });
        await svc.recomputeTotals(plan.id);
        res.json({ ok: true });
    } catch (e) {
        console.error('[eventPlan] deleteItem', e?.message);
        res.status(500).json({ error: 'Falha ao excluir o item.' });
    }
};

// ── Fluxo ────────────────────────────────────────────────────────────────────

export const submitPlan = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        const events = await PlannedEvent.findAll({ where: { plan_id: plan.id } });
        const openPlan = svc.canEditPlan(req.user, plan);
        // Plano aprovado só reabre para enviar EXTRA — e sem mexer no que já foi
        // decidido.
        const sendingExtras = !openPlan
            && svc.canAddExtraEvent(req.user, plan)
            && svc.hasPendingExtras(events);

        if (!openPlan && !sendingExtras) {
            return res.status(403).json({ error: 'Só o gestor responsável submete, e só com o plano aberto.' });
        }

        // Mesma rotina do envio automático do fim da janela — uma regra só.
        const result = await svc.submitPlanCore(plan, { userId: req.user.id, auto: false });
        if (!result.ok) {
            return res.status(400).json({ error: 'Inclua ao menos um evento antes de enviar.' });
        }
        await notifier.notifySubmitted(plan);

        res.json({ ok: true, status: plan.status });
    } catch (e) {
        console.error('[eventPlan] submitPlan', e?.message);
        res.status(500).json({ error: 'Falha ao enviar o plano.' });
    }
};

export const decidePlan = async (req, res) => {
    try {
        const stage = String(req.body?.stage || '').toUpperCase();
        const result = await applyDecisions({
            user: req.user,
            planId: Number(req.params.id),
            stage,
            events: Array.isArray(req.body?.events) ? req.body.events : [],
            planComment: req.body?.plan_comment || null,
            returnPlan: Boolean(req.body?.return_plan),
        });

        // Publicar na agenda e notificar acontecem DEPOIS da transação: efeito
        // colateral não pode derrubar a decisão já gravada.
        let published = 0;
        if (!result.returned && stage === 'MARKETING') {
            const agenda = await publishApprovedEvents(Number(req.params.id), req.user.id);
            published = agenda.published;
        }

        const fresh = await EventPlan.findByPk(req.params.id);
        if (result.returned) {
            await notifier.notifyReturned(fresh, stage, req.body?.plan_comment || null);
        } else {
            await notifier.notifyDecided(fresh, stage, { nextStatus: result.status });
        }

        res.json({ ...result, published });
    } catch (e) {
        if (e instanceof DecisionError) {
            return res.status(e.status).json({ error: e.message, details: e.details });
        }
        console.error('[eventPlan] decidePlan', e?.message);
        res.status(500).json({ error: 'Falha ao registrar a decisão.' });
    }
};

export const closePlan = async (req, res) => {
    try {
        const plan = await loadPlanOr404(req.params.id, res);
        if (!plan) return;
        if (!(await assertReach(req, res, plan))) return;

        // Fechar o mês congela tudo — mesma dupla validação da Ficha Comercial.
        if (req.body?.confirmation !== 'FECHAR') {
            return res.status(400).json({ error: 'Confirmação obrigatória — digite "FECHAR" para prosseguir.' });
        }
        if (plan.status === PLAN_STATUS.CLOSED) {
            return res.status(409).json({ error: 'Este mês já está fechado.' });
        }
        const canClose = isAdmin(req) || (await svc.decidableStagesForUser(req.user)).length > 0;
        if (!canClose) return res.status(403).json({ error: 'Sem alçada para fechar o mês.' });

        await plan.update({
            status: PLAN_STATUS.CLOSED,
            closed_at: new Date(),
            closed_by: req.user.id,
            closing_note: req.body?.note || null,
            updated_by: req.user.id,
        });
        const totals = await svc.recomputeTotals(plan.id);

        await svc.logActivity({
            planId: plan.id, userId: req.user.id, action: ACTIVITY.PLAN_CLOSED,
            meta: { totals, note: req.body?.note || null },
        });
        await notifier.notifyClosed(await EventPlan.findByPk(plan.id));
        res.json({ ok: true, status: plan.status, totals });
    } catch (e) {
        console.error('[eventPlan] closePlan', e?.message);
        res.status(500).json({ error: 'Falha ao fechar o mês.' });
    }
};

// ── Configuração (admin) ─────────────────────────────────────────────────────

export const getSettings = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const settings = await svc.getSettings();
        const profiles = await EventPlanAuthProfile.findAll({ order: [['name', 'ASC']] });
        res.json({ settings, profiles });
    } catch (e) {
        console.error('[eventPlan] getSettings', e?.message);
        res.status(500).json({ error: 'Falha ao carregar configurações.' });
    }
};

export const updateSettings = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const settings = await svc.getSettings();
        const allowed = [
            'stages', 'open_days_before_month_end', 'priority_window_days', 'auto_submit_enabled',
            'item_categories', 'chase_enabled', 'chase_offsets', 'run_hour', 'timezone', 'respect_user_prefs',
            // deadline_day é legado (regra antiga de prazo no mês de referência);
            // o motor não lê mais, então nem entra na lista de gravação.
        ];
        const patch = {};
        for (const key of allowed) if (req.body?.[key] !== undefined) patch[key] = req.body[key];
        patch.updated_by = req.user.id;
        await settings.update(patch);
        res.json(settings);
    } catch (e) {
        console.error('[eventPlan] updateSettings', e?.message);
        res.status(500).json({ error: 'Falha ao salvar configurações.' });
    }
};

// Lista de usuários para montar os perfis de alçada. Admin-only: é usada só
// pela tela de configuração do módulo.
export const listUsers = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const users = await User.findAll({
            attributes: ['id', 'username', 'email'],
            order: [['username', 'ASC']],
        });
        res.json(users);
    } catch (e) {
        console.error('[eventPlan] listUsers', e?.message);
        res.status(500).json({ error: 'Falha ao listar usuários.' });
    }
};

export const upsertAuthProfile = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const { id, name, description, user_ids, is_active } = req.body || {};
        if (!String(name || '').trim()) return res.status(400).json({ error: 'Informe o nome do perfil.' });

        const payload = {
            name: String(name).trim(),
            description: description ? String(description) : null,
            user_ids: Array.isArray(user_ids) ? user_ids.map(Number).filter(Boolean) : [],
            is_active: is_active !== false,
            updated_by: req.user.id,
        };

        if (id) {
            const profile = await EventPlanAuthProfile.findByPk(id);
            if (!profile) return res.status(404).json({ error: 'Perfil não encontrado.' });
            await profile.update(payload);
            return res.json(profile);
        }
        const created = await EventPlanAuthProfile.create({ ...payload, created_by: req.user.id });
        res.status(201).json(created);
    } catch (e) {
        console.error('[eventPlan] upsertAuthProfile', e?.message);
        res.status(500).json({ error: 'Falha ao salvar o perfil.' });
    }
};

export const deleteAuthProfile = async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas administradores.' });
        const profile = await EventPlanAuthProfile.findByPk(req.params.profileId);
        if (!profile) return res.status(404).json({ error: 'Perfil não encontrado.' });
        // Desativa em vez de apagar: as decisões já gravadas apontam para ele.
        await profile.update({ is_active: false, updated_by: req.user.id });
        res.json({ ok: true });
    } catch (e) {
        console.error('[eventPlan] deleteAuthProfile', e?.message);
        res.status(500).json({ error: 'Falha ao desativar o perfil.' });
    }
};
