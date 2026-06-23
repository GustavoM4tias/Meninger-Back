// services/checklist/checklistService.js
import { Op, fn, col } from 'sequelize';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { loadStatusMap, computeProgress, recomputeProgress, logActivity } from './lib.js';

// ── Checklists ────────────────────────────────────────────────────────────────

export async function listChecklists({ status, idempreendimento, ownerUserId } = {}) {
    const where = {};
    if (status) where.status = status;
    else where.status = { [Op.ne]: 'archived' }; // default: ativos + concluídos
    if (idempreendimento) where.idempreendimento = Number(idempreendimento);
    if (ownerUserId) where.owner_user_id = Number(ownerUserId);

    const rows = await db.Checklist.findAll({
        where,
        include: [{ association: 'owner', attributes: ['id', 'username'], required: false }],
        order: [['created_at', 'DESC']],
    });
    return rows.map((r) => r.get({ plain: true }));
}

export async function getChecklistFull({ id }) {
    const checklist = await db.Checklist.findByPk(Number(id), {
        include: [{ association: 'owner', attributes: ['id', 'username', 'email'], required: false }],
    });
    if (!checklist) throw new Error('Checklist não encontrado.');

    const [sections, tasks, statuses] = await Promise.all([
        db.ChecklistSection.findAll({ where: { checklist_id: id }, order: [['position', 'ASC'], ['id', 'ASC']] }),
        db.ChecklistTask.findAll({
            where: { checklist_id: id },
            include: [{ association: 'assignee', attributes: ['id', 'username', 'email'], required: false }],
            order: [['position', 'ASC'], ['id', 'ASC']],
        }),
        db.ChecklistStatus.findAll({
            where: {
                is_active: true,
                [Op.or]: [{ scope: 'GLOBAL' }, { scope: 'TEMPLATE', template_id: checklist.template_id || -1 }],
            },
            order: [['position', 'ASC'], ['id', 'ASC']],
        }),
    ]);

    const taskIds = tasks.map((t) => t.id);
    const [attCounts, comCounts] = await Promise.all([
        taskIds.length
            ? db.ChecklistTaskAttachment.findAll({ where: { task_id: taskIds }, attributes: ['task_id', [fn('COUNT', col('id')), 'c']], group: ['task_id'], raw: true })
            : [],
        taskIds.length
            ? db.ChecklistTaskComment.findAll({ where: { task_id: taskIds }, attributes: ['task_id', [fn('COUNT', col('id')), 'c']], group: ['task_id'], raw: true })
            : [],
    ]);
    const attMap = new Map(attCounts.map((r) => [Number(r.task_id), Number(r.c)]));
    const comMap = new Map(comCounts.map((r) => [Number(r.task_id), Number(r.c)]));

    const statusMap = new Map(statuses.map((s) => [s.id, s.get({ plain: true })]));
    const plainTasks = tasks.map((t) => {
        const p = t.get({ plain: true });
        p.attachments_count = attMap.get(p.id) || 0;
        p.comments_count = comMap.get(p.id) || 0;
        p.state_class = p.status_id ? (statusMap.get(p.status_id)?.state_class || 'TODO') : 'TODO';
        return p;
    });

    const progress = computeProgress(plainTasks, statusMap);

    return {
        checklist: { ...checklist.get({ plain: true }), progress },
        sections: sections.map((s) => s.get({ plain: true })),
        statuses: statuses.map((s) => s.get({ plain: true })),
        tasks: plainTasks,
    };
}

export async function createChecklist({ payload = {}, userId }) {
    const { title, kind = 'GENERIC', idempreendimento = null, display_name = null, key_dates = [], owner_user_id = null, color = null, template_id = null } = payload;
    if (!title) throw new Error('Título é obrigatório.');

    const checklist = await db.Checklist.create({
        title,
        kind,
        idempreendimento,
        display_name,
        key_dates: Array.isArray(key_dates) ? key_dates : [],
        owner_user_id: owner_user_id || userId || null,
        color,
        template_id,
        status: 'active',
        created_by: userId || null,
        updated_by: userId || null,
        progress_cache: { total: 0, done: 0, pct: 0, overdue: 0, budget: 0 },
    });
    await logActivity({ checklistId: checklist.id, userId, action: 'checklist.created', meta: { title } });
    return getChecklistFull({ id: checklist.id });
}

export async function updateChecklist({ id, payload = {}, userId }) {
    const checklist = await db.Checklist.findByPk(Number(id));
    if (!checklist) throw new Error('Checklist não encontrado.');

    const fields = ['title', 'idempreendimento', 'display_name', 'key_dates', 'owner_user_id', 'color', 'status', 'kind', 'reminder_mode'];
    for (const f of fields) if (f in payload) checklist[f] = payload[f];
    checklist.updated_by = userId || null;
    await checklist.save();
    await logActivity({ checklistId: checklist.id, userId, action: 'checklist.updated' });
    return getChecklistFull({ id: checklist.id });
}

export async function archiveChecklist({ id, userId }) {
    const checklist = await db.Checklist.findByPk(Number(id));
    if (!checklist) throw new Error('Checklist não encontrado.');
    checklist.status = 'archived';
    checklist.updated_by = userId || null;
    await checklist.save();
    await logActivity({ checklistId: checklist.id, userId, action: 'checklist.archived' });
    return { ok: true };
}

export async function deleteChecklist({ id }) {
    const checklist = await db.Checklist.findByPk(Number(id));
    if (!checklist) throw new Error('Checklist não encontrado.');
    await checklist.destroy(); // cascata remove seções/tarefas/atividades
    return { ok: true };
}

// ── Dashboard / minhas tarefas ────────────────────────────────────────────────

export async function myTasks({ userId, limit = 200 }) {
    if (!userId) return [];
    const statusMap = await loadStatusMap();

    // Retorna TODAS as tarefas vinculadas ao usuário (inclusive concluídas) — o
    // filtro fica no frontend. Assim nada "some" e os filtros de Minhas Tarefas
    // funcionam sobre o conjunto completo.
    const rows = await db.ChecklistTask.findAll({
        where: { assignee_user_id: Number(userId) },
        include: [{
            association: 'checklist',
            attributes: ['id', 'title', 'idempreendimento', 'display_name', 'status'],
            required: true,
            where: { status: { [Op.ne]: 'archived' } },
        }],
        order: [['due_date', 'ASC']],
        limit,
    });
    return rows.map((r) => {
        const p = r.get({ plain: true });
        p.state_class = p.status_id ? (statusMap.get(p.status_id)?.state_class || 'TODO') : 'TODO';
        p.status_label = p.status_id ? (statusMap.get(p.status_id)?.label || null) : null;
        return p;
    });
}

export async function dashboard({ userId }) {
    const checklists = await listChecklists({}); // não-arquivados
    const ids = checklists.map((c) => c.id);
    const statusMap = await loadStatusMap();
    const checklistTitle = new Map(checklists.map((c) => [c.id, c.title]));

    const tasks = ids.length ? await db.ChecklistTask.findAll({
        where: { checklist_id: ids },
        include: [{ association: 'assignee', attributes: ['id', 'username'], required: false }],
        attributes: ['id', 'checklist_id', 'status_id', 'due_date', 'value', 'value_kind', 'assignee_user_id', 'assignee_label', 'title'],
    }) : [];

    const today = dayjs().format('YYYY-MM-DD');
    const weekEnd = dayjs().add(7, 'day').format('YYYY-MM-DD');

    let totalTasks = 0, totalDone = 0, totalOverdue = 0, totalBudget = 0, totalMonthly = 0;
    const byStatus = { TODO: 0, IN_PROGRESS: 0, BLOCKED: 0, DONE: 0 };
    const byAssignee = new Map();
    const dueSoon = [];
    const overdue = [];

    for (const row of tasks) {
        const t = row.get({ plain: true });
        const sc = t.status_id ? (statusMap.get(t.status_id)?.state_class || 'TODO') : 'TODO';
        if (sc === 'CANCELLED') continue;
        totalTasks++;
        if (byStatus[sc] !== undefined) byStatus[sc]++;
        if (sc === 'DONE') totalDone++;
        const v = Number(t.value) || 0;
        if (t.value_kind === 'MONTHLY') totalMonthly += v; else totalBudget += v;

        const isOverdue = t.due_date && sc !== 'DONE' && String(t.due_date) < today;
        const item = { id: t.id, title: t.title, checklist_id: t.checklist_id, checklistTitle: checklistTitle.get(t.checklist_id), due_date: t.due_date, assignee: t.assignee?.username || t.assignee_label || null };
        if (isOverdue) { totalOverdue++; overdue.push(item); }
        else if (sc !== 'DONE' && t.due_date && t.due_date >= today && t.due_date <= weekEnd) dueSoon.push(item);

        const key = t.assignee_user_id ? 'u' + t.assignee_user_id : (t.assignee_label ? 'l' + t.assignee_label.toLowerCase() : 'none');
        const name = t.assignee?.username || t.assignee_label || 'Sem responsável';
        if (!byAssignee.has(key)) byAssignee.set(key, { key, name, linked: !!t.assignee_user_id, total: 0, done: 0, overdue: 0 });
        const a = byAssignee.get(key);
        a.total++; if (sc === 'DONE') a.done++; if (isOverdue) a.overdue++;
    }

    overdue.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    dueSoon.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    const byAssigneeArr = Array.from(byAssignee.values())
        .map((a) => ({ ...a, pct: a.total ? Math.round((a.done / a.total) * 100) : 0 }))
        .sort((a, b) => (b.overdue - a.overdue) || (b.total - a.total));

    const mine = await myTasks({ userId });
    return {
        summary: {
            checklists: checklists.length,
            totalTasks, totalDone, totalOverdue, totalBudget, totalMonthly,
            pct: totalTasks ? Math.round((totalDone / totalTasks) * 100) : 0,
        },
        byStatus,
        byAssignee: byAssigneeArr,
        dueSoon: dueSoon.slice(0, 30),
        overdue: overdue.slice(0, 30),
        checklists,
        myTasks: mine,
    };
}

// ── Seções ────────────────────────────────────────────────────────────────────

export async function addSection({ checklistId, payload = {}, userId }) {
    const checklist = await db.Checklist.findByPk(Number(checklistId), { attributes: ['id'] });
    if (!checklist) throw new Error('Checklist não encontrado.');
    const max = await db.ChecklistSection.max('position', { where: { checklist_id: checklistId } });
    const section = await db.ChecklistSection.create({
        checklist_id: Number(checklistId),
        name: payload.name || 'Nova seção',
        color: payload.color || null,
        position: payload.position ?? ((Number(max) || 0) + 10),
    });
    await logActivity({ checklistId: Number(checklistId), userId, action: 'section.created', meta: { sectionId: section.id } });
    return section.get({ plain: true });
}

export async function updateSection({ id, payload = {} }) {
    const section = await db.ChecklistSection.findByPk(Number(id));
    if (!section) throw new Error('Seção não encontrada.');
    for (const f of ['name', 'color', 'position']) if (f in payload) section[f] = payload[f];
    await section.save();
    return section.get({ plain: true });
}

export async function removeSection({ id, userId }) {
    const section = await db.ChecklistSection.findByPk(Number(id));
    if (!section) throw new Error('Seção não encontrada.');
    const checklistId = section.checklist_id;
    await section.destroy(); // cascata remove as tarefas da seção
    await recomputeProgress(checklistId);
    await logActivity({ checklistId, userId, action: 'section.removed' });
    return { ok: true };
}

// ── Catálogo de status ────────────────────────────────────────────────────────

export async function listStatuses({ templateId } = {}) {
    const scopes = [{ scope: 'GLOBAL' }];
    if (templateId) scopes.push({ scope: 'TEMPLATE', template_id: Number(templateId) });
    const rows = await db.ChecklistStatus.findAll({
        where: { is_active: true, [Op.or]: scopes },
        order: [['position', 'ASC'], ['id', 'ASC']],
    });
    return rows.map((r) => r.get({ plain: true }));
}

const VALID_STATE_CLASSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'];

export async function createStatus({ payload = {} }) {
    const { label, color = null, state_class = 'TODO', scope = 'GLOBAL', template_id = null, position = 0 } = payload;
    if (!label) throw new Error('Label é obrigatório.');
    if (!VALID_STATE_CLASSES.includes(state_class)) throw new Error('state_class inválido.');
    const row = await db.ChecklistStatus.create({
        label, color, state_class, scope,
        template_id: scope === 'TEMPLATE' ? template_id : null,
        position, is_active: true,
    });
    return row.get({ plain: true });
}

export async function updateStatus({ id, payload = {} }) {
    const row = await db.ChecklistStatus.findByPk(Number(id));
    if (!row) throw new Error('Status não encontrado.');
    if (payload.state_class && !VALID_STATE_CLASSES.includes(payload.state_class)) throw new Error('state_class inválido.');
    for (const f of ['label', 'color', 'state_class', 'position', 'is_active']) if (f in payload) row[f] = payload[f];
    await row.save();
    return row.get({ plain: true });
}

export async function removeStatus({ id }) {
    // Soft: desativa para nao orfanar status_id de tarefas existentes.
    const row = await db.ChecklistStatus.findByPk(Number(id));
    if (!row) throw new Error('Status não encontrado.');
    row.is_active = false;
    await row.save();
    return { ok: true };
}

// ── Usuários (seletor de responsável) ─────────────────────────────────────────
export async function listUsers() {
    const rows = await db.User.findAll({
        where: { status: true, external_organization_id: null },
        attributes: ['id', 'username', 'email', 'position'],
        order: [['username', 'ASC']],
    });
    return rows.map((r) => r.get({ plain: true }));
}

// ── Empreendimentos do CV (seletor) ───────────────────────────────────────────
export async function listEnterprises() {
    if (!db.CvEnterprise) return [];
    const rows = await db.CvEnterprise.findAll({
        attributes: ['idempreendimento', 'nome', 'cidade'],
        order: [['nome', 'ASC']],
    });
    return rows.map((r) => r.get({ plain: true }));
}

export default {
    listChecklists, getChecklistFull, createChecklist, updateChecklist, archiveChecklist, deleteChecklist,
    myTasks, dashboard, listUsers, listEnterprises,
    addSection, updateSection, removeSection,
    listStatuses, createStatus, updateStatus, removeStatus,
};
