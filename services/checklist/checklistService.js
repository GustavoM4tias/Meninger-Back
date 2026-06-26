// services/checklist/checklistService.js
import { Op, fn, col } from 'sequelize';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { loadStatusMap, computeProgress, recomputeProgress, logActivity } from './lib.js';
import authProfileService from './authProfileService.js';

// ── Checklists ────────────────────────────────────────────────────────────────

// Checklists "vinculados" ao usuário: onde ele é responsável de alguma tarefa.
async function visibleChecklistIds(userId) {
    if (!userId) return [];
    const rows = await db.ChecklistTask.findAll({
        where: { [Op.or]: [{ assignee_user_id: Number(userId) }, { assignee_user_ids: { [Op.contains]: [Number(userId)] } }] },
        attributes: ['checklist_id'], group: ['checklist_id'], raw: true,
    });
    return rows.map((r) => Number(r.checklist_id));
}

export async function listChecklists({ status, idempreendimento, ownerUserId, requesterId, isAdmin = true } = {}) {
    const where = {};
    if (status) where.status = status;
    else where.status = { [Op.ne]: 'archived' }; // default: ativos + concluídos
    if (idempreendimento) where.idempreendimento = Number(idempreendimento);
    if (ownerUserId) where.owner_user_id = Number(ownerUserId);
    // Não-admin: só os vinculados a si (dono OU responsável de alguma tarefa).
    if (!isAdmin && requesterId) {
        const ids = await visibleChecklistIds(requesterId);
        where[Op.and] = [{ [Op.or]: [{ id: ids.length ? ids : [-1] }, { owner_user_id: Number(requesterId) }] }];
    }

    const rows = await db.Checklist.findAll({
        where,
        include: [{ association: 'owner', attributes: ['id', 'username'], required: false }],
        order: [['created_at', 'DESC']],
    });
    return rows.map((r) => r.get({ plain: true }));
}

export async function getChecklistFull({ id, requesterId, isAdmin = true }) {
    const checklist = await db.Checklist.findByPk(Number(id), {
        include: [{ association: 'owner', attributes: ['id', 'username', 'email'], required: false }],
    });
    if (!checklist) throw new Error('Checklist não encontrado.');
    // Não-admin acessa se: dono, responsável de alguma tarefa, OU aprovador (membro de
    // perfil) de alguma tarefa em aprovação neste checklist (visão completa p/ decidir).
    if (!isAdmin && requesterId && checklist.owner_user_id !== Number(requesterId)) {
        const cnt = await db.ChecklistTask.count({
            where: { checklist_id: id, [Op.or]: [{ assignee_user_id: Number(requesterId) }, { assignee_user_ids: { [Op.contains]: [Number(requesterId)] } }] },
        });
        let allowed = cnt > 0;
        if (!allowed) {
            const myProfileIds = (await authProfileService.profilesForUser(requesterId)).map((p) => p.id);
            if (myProfileIds.length) {
                const pend = await db.ChecklistTask.findAll({ where: { checklist_id: id, approval_status: 'PENDING' }, attributes: ['auth_profile_ids'], raw: true });
                allowed = pend.some((t) => (t.auth_profile_ids || []).some((pid) => myProfileIds.includes(Number(pid))));
            }
        }
        if (!allowed) { const e = new Error('Você não tem acesso a este checklist.'); e.httpStatus = 403; throw e; }
    }

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
    const { title, kind = 'GENERIC', idempreendimento = null, display_name = null, cost_center = null, key_dates = [], owner_user_id = null, color = null, template_id = null } = payload;
    if (!title) throw new Error('Título é obrigatório.');

    const checklist = await db.Checklist.create({
        title,
        kind,
        idempreendimento,
        display_name,
        cost_center,
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

    const fields = ['title', 'idempreendimento', 'display_name', 'cost_center', 'key_dates', 'owner_user_id', 'color', 'status', 'kind', 'reminder_mode'];
    for (const f of fields) if (f in payload) checklist[f] = payload[f];
    checklist.updated_by = userId || null;
    await checklist.save();
    await logActivity({ checklistId: checklist.id, userId, action: 'checklist.updated' });
    return getChecklistFull({ id: checklist.id });
}

// Clona um checklist exatamente como está: seções + tarefas (campos, etapa, prazos,
// valores, responsáveis, subtarefas, config de autorização). O clone nasce em RASCUNHO
// e com a aprovação zerada (é um novo começo). Comentários/anexos/atividade NÃO são copiados.
export async function cloneChecklist({ id, userId, title }) {
    const src = await db.Checklist.findByPk(Number(id));
    if (!src) throw new Error('Checklist não encontrado.');
    const [sections, tasks] = await Promise.all([
        db.ChecklistSection.findAll({ where: { checklist_id: id }, order: [['position', 'ASC'], ['id', 'ASC']] }),
        db.ChecklistTask.findAll({ where: { checklist_id: id }, order: [['position', 'ASC'], ['id', 'ASC']] }),
    ]);
    const clone = await db.Checklist.create({
        template_id: src.template_id, title: (title || `${src.title} (cópia)`).trim(),
        kind: src.kind, idempreendimento: src.idempreendimento, display_name: src.display_name,
        cost_center: src.cost_center, key_dates: src.key_dates || [], owner_user_id: userId || src.owner_user_id || null,
        color: src.color, reminder_mode: src.reminder_mode, status: 'draft',
        progress_cache: { total: 0, done: 0, pct: 0, overdue: 0, budget: 0 },
        created_by: userId || null, updated_by: userId || null,
    });
    const secMap = new Map();
    for (const s of sections) {
        const ns = await db.ChecklistSection.create({ checklist_id: clone.id, name: s.name, color: s.color, position: s.position ?? 0 });
        secMap.set(s.id, ns.id);
    }
    for (const t of tasks) {
        const sectionId = secMap.get(t.section_id);
        if (!sectionId) continue;
        await db.ChecklistTask.create({
            checklist_id: clone.id, section_id: sectionId, parent_task_id: null,
            category: t.category, title: t.title, description: t.description, status_id: t.status_id,
            priority: t.priority, value: t.value, value_kind: t.value_kind,
            contracted_at: t.contracted_at, due_date: t.due_date,
            assignee_user_id: t.assignee_user_id, assignee_user_ids: t.assignee_user_ids || [], assignee_label: t.assignee_label,
            checklist_items: t.checklist_items || [], needs_authorization: t.needs_authorization, auth_profile_ids: t.auth_profile_ids || [],
            approval_status: 'NONE', approval_round: 0,
            position: t.position ?? 0, created_by: userId || null, updated_by: userId || null,
        });
    }
    await recomputeProgress(clone.id);
    await logActivity({ checklistId: clone.id, userId, action: 'checklist.created', meta: { cloned_from: src.id } });
    return getChecklistFull({ id: clone.id, isAdmin: true });
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
        where: { [Op.or]: [{ assignee_user_id: Number(userId) }, { assignee_user_ids: { [Op.contains]: [Number(userId)] } }] },
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

export async function dashboard({ userId, isAdmin = true }) {
    const checklists = await listChecklists({ requesterId: userId, isAdmin }); // escopado p/ não-admin
    const ids = checklists.map((c) => c.id);
    const statusMap = await loadStatusMap();
    const checklistTitle = new Map(checklists.map((c) => [c.id, c.title]));

    const tasks = ids.length ? await db.ChecklistTask.findAll({
        where: { checklist_id: ids },
        include: [{ association: 'assignee', attributes: ['id', 'username'], required: false }],
        attributes: ['id', 'checklist_id', 'status_id', 'priority', 'due_date', 'value', 'value_kind', 'assignee_user_id', 'assignee_user_ids', 'assignee_label', 'title'],
    }) : [];

    // Mapa de nomes p/ todos os responsáveis (multi-responsável).
    const allAssigneeIds = new Set();
    tasks.forEach((row) => (row.assignee_user_ids || []).forEach((u) => allAssigneeIds.add(Number(u))));
    const userMap = allAssigneeIds.size
        ? new Map((await db.User.findAll({ where: { id: [...allAssigneeIds] }, attributes: ['id', 'username'], raw: true })).map((u) => [u.id, u.username]))
        : new Map();

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
        const item = { id: t.id, title: t.title, checklist_id: t.checklist_id, checklistTitle: checklistTitle.get(t.checklist_id), due_date: t.due_date, assignee: t.assignee?.username || t.assignee_label || null, priority: t.priority, state_class: sc, status_label: t.status_id ? (statusMap.get(t.status_id)?.label || null) : null, value: t.value };
        if (isOverdue) { totalOverdue++; overdue.push(item); }
        else if (sc !== 'DONE' && t.due_date && t.due_date >= today && t.due_date <= weekEnd) dueSoon.push(item);

        // Conta a tarefa para CADA responsável (tarefa em grupo aparece p/ todos).
        const aids = (Array.isArray(t.assignee_user_ids) && t.assignee_user_ids.length)
            ? t.assignee_user_ids.map(Number).filter(Boolean)
            : (t.assignee_user_id ? [Number(t.assignee_user_id)] : []);
        const buckets = aids.length
            ? aids.map((uid) => ({ key: 'u' + uid, name: userMap.get(uid) || t.assignee?.username || ('#' + uid), linked: true }))
            : [{ key: t.assignee_label ? 'l' + t.assignee_label.toLowerCase() : 'none', name: t.assignee_label || 'Sem responsável', linked: false }];
        for (const b of buckets) {
            if (!byAssignee.has(b.key)) byAssignee.set(b.key, { key: b.key, name: b.name, linked: b.linked, total: 0, done: 0, overdue: 0 });
            const a = byAssignee.get(b.key);
            a.total++; if (sc === 'DONE') a.done++; if (isOverdue) a.overdue++;
        }
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
    const { label, color = null, state_class = 'TODO', scope = 'GLOBAL', template_id = null, position = 0, requires_approval = false, approval_role = null } = payload;
    if (!label) throw new Error('Label é obrigatório.');
    if (!VALID_STATE_CLASSES.includes(state_class)) throw new Error('state_class inválido.');
    const row = await db.ChecklistStatus.create({
        label, color, state_class, scope,
        template_id: scope === 'TEMPLATE' ? template_id : null,
        position, is_active: true,
        requires_approval: !!requires_approval,
        approval_role: approval_role || null,
    });
    return row.get({ plain: true });
}

export async function updateStatus({ id, payload = {} }) {
    const row = await db.ChecklistStatus.findByPk(Number(id));
    if (!row) throw new Error('Status não encontrado.');
    if (payload.state_class && !VALID_STATE_CLASSES.includes(payload.state_class)) throw new Error('state_class inválido.');
    for (const f of ['label', 'color', 'state_class', 'position', 'is_active', 'requires_approval', 'approval_role']) if (f in payload) row[f] = payload[f];
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
        attributes: ['id', 'username', 'email', 'position', 'phone'],
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
    listChecklists, getChecklistFull, createChecklist, updateChecklist, cloneChecklist, archiveChecklist, deleteChecklist,
    myTasks, dashboard, listUsers, listEnterprises,
    addSection, updateSection, removeSection,
    listStatuses, createStatus, updateStatus, removeStatus,
};
