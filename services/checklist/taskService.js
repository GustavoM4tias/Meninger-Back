// services/checklist/taskService.js
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { loadStatusMap, recomputeProgress, logActivity, parseMentions } from './lib.js';

// ── Notificações (best-effort, nunca lançam) ──────────────────────────────────

async function notifyAssigned({ task, checklist, actorId, channels = null }) {
    try {
        if (!task.assignee_user_id || task.assignee_user_id === actorId) return;
        await NotificationService.notify({
            type: NotificationType.CHECKLIST_TASK_ASSIGNED,
            recipients: { users: [task.assignee_user_id] },
            title: `Nova tarefa: ${task.title}`,
            body: checklist?.title || null,
            data: { checklistId: task.checklist_id, taskId: task.id },
            link: `/checklists/${task.checklist_id}?task=${task.id}`,
            importance: 6,
            // Quando o usuário escolhe os canais na tarefa, honra direto (bypass de preferência).
            ...(channels ? { channels, bypassPrefs: true } : {}),
        });
    } catch (err) { console.warn('[checklist.notifyAssigned]', err?.message || err); }
}

async function notifyCompleted({ task, actorId }) {
    try {
        const checklist = await db.Checklist.findByPk(task.checklist_id, { attributes: ['id', 'title', 'owner_user_id'] });
        if (!checklist?.owner_user_id || checklist.owner_user_id === actorId) return;
        await NotificationService.notify({
            type: NotificationType.CHECKLIST_TASK_COMPLETED,
            recipients: { users: [checklist.owner_user_id] },
            title: `Concluída: ${task.title}`,
            body: checklist.title,
            data: { checklistId: checklist.id, taskId: task.id },
            link: `/checklists/${checklist.id}?task=${task.id}`,
            importance: 4,
        });
    } catch (err) { console.warn('[checklist.notifyCompleted]', err?.message || err); }
}

async function notifyComment({ task, body, actorId }) {
    try {
        const recipients = new Set();
        if (task.assignee_user_id && task.assignee_user_id !== actorId) recipients.add(task.assignee_user_id);
        const mentions = parseMentions(body);
        if (mentions.length) {
            const users = await db.User.findAll({ where: { username: mentions }, attributes: ['id'], raw: true });
            users.forEach((u) => { if (u.id !== actorId) recipients.add(u.id); });
        }
        if (!recipients.size) return;
        await NotificationService.notify({
            type: NotificationType.CHECKLIST_TASK_COMMENT,
            recipients: { users: Array.from(recipients) },
            title: `Comentário em: ${task.title}`,
            body: String(body).slice(0, 140),
            data: { checklistId: task.checklist_id, taskId: task.id },
            link: `/checklists/${task.checklist_id}?task=${task.id}`,
            importance: 5,
        });
    } catch (err) { console.warn('[checklist.notifyComment]', err?.message || err); }
}

// ── Tarefas ───────────────────────────────────────────────────────────────────

export async function getTask({ id }) {
    const task = await db.ChecklistTask.findByPk(Number(id), {
        include: [{ association: 'assignee', attributes: ['id', 'username', 'email'], required: false }],
    });
    if (!task) throw new Error('Tarefa não encontrada.');
    const [attachments, comments, activity, subtasks, statusMap] = await Promise.all([
        db.ChecklistTaskAttachment.findAll({ where: { task_id: id }, order: [['created_at', 'DESC']] }),
        db.ChecklistTaskComment.findAll({ where: { task_id: id }, include: [{ association: 'author', attributes: ['id', 'username'], required: false }], order: [['created_at', 'ASC']] }),
        db.ChecklistActivity.findAll({ where: { task_id: id }, include: [{ association: 'actor', attributes: ['id', 'username'], required: false }], order: [['created_at', 'DESC']], limit: 50 }),
        db.ChecklistTask.findAll({ where: { parent_task_id: id }, order: [['position', 'ASC']] }),
        loadStatusMap(),
    ]);
    const p = task.get({ plain: true });
    p.state_class = p.status_id ? (statusMap.get(p.status_id)?.state_class || 'TODO') : 'TODO';
    return {
        task: p,
        attachments: attachments.map((a) => a.get({ plain: true })),
        comments: comments.map((c) => c.get({ plain: true })),
        activity: activity.map((a) => a.get({ plain: true })),
        subtasks: subtasks.map((s) => s.get({ plain: true })),
    };
}

export async function createTask({ checklistId, payload = {}, userId }) {
    const checklist = await db.Checklist.findByPk(Number(checklistId), { attributes: ['id', 'title'] });
    if (!checklist) throw new Error('Checklist não encontrado.');
    const sectionId = Number(payload.section_id);
    if (!sectionId) throw new Error('section_id é obrigatório.');
    if (!payload.title) throw new Error('Título é obrigatório.');

    const max = await db.ChecklistTask.max('position', { where: { section_id: sectionId } });
    const task = await db.ChecklistTask.create({
        checklist_id: checklist.id,
        section_id: sectionId,
        parent_task_id: payload.parent_task_id || null,
        category: payload.category || null,
        title: payload.title,
        description: payload.description || null,
        status_id: payload.status_id || null,
        priority: payload.priority || 'MEDIUM',
        value: payload.value ?? null,
        value_kind: payload.value_kind || null,
        contracted_at: payload.contracted_at || null,
        due_date: payload.due_date || null,
        assignee_user_id: payload.assignee_user_id || null,
        assignee_label: payload.assignee_label || null,
        position: payload.position ?? ((Number(max) || 0) + 10),
        created_by: userId || null,
        updated_by: userId || null,
    });
    await recomputeProgress(checklist.id);
    await logActivity({ checklistId: checklist.id, taskId: task.id, userId, action: 'task.created', meta: { title: task.title } });
    if (payload.notify !== false && task.assignee_user_id) await notifyAssigned({ task, checklist, actorId: userId, channels: payload.channels || null });
    return getTask({ id: task.id });
}

export async function updateTask({ id, payload = {}, userId }) {
    const task = await db.ChecklistTask.findByPk(Number(id));
    if (!task) throw new Error('Tarefa não encontrada.');
    const prevAssignee = task.assignee_user_id;
    // Controle de notificação por tarefa: notify=false salva em silêncio; channels escolhe os canais.
    const notify = payload.notify !== false;
    const channels = payload.channels || null;

    const fields = ['section_id', 'parent_task_id', 'category', 'title', 'description', 'status_id', 'priority', 'value', 'value_kind', 'contracted_at', 'due_date', 'started_at', 'assignee_user_id', 'assignee_label', 'position'];
    for (const f of fields) if (f in payload) task[f] = payload[f];
    // Campos realmente alterados (Sequelize rastreia) — evita "atualizou" vazio na atividade.
    const changedFields = (task.changed() || []).filter((f) => f !== 'updated_at' && f !== 'updated_by');
    // Guarda o antes/depois de cada campo p/ o histórico mostrar "prazo: 20/06 → 23/06".
    const changes = {};
    for (const f of changedFields) changes[f] = { from: task.previous(f) ?? null, to: task[f] ?? null };
    task.updated_by = userId || null;

    if ('status_id' in payload) {
        const statusMap = await loadStatusMap();
        const sc = task.status_id ? statusMap.get(task.status_id)?.state_class : 'TODO';
        if (sc === 'DONE' && !task.completed_at) task.completed_at = new Date();
        if (sc !== 'DONE') task.completed_at = null;
    }
    await task.save();
    await recomputeProgress(task.checklist_id);
    if (changedFields.length) await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: 'task.updated', meta: { fields: changedFields, changes } });

    if (notify && task.assignee_user_id && task.assignee_user_id !== prevAssignee) {
        const checklist = await db.Checklist.findByPk(task.checklist_id, { attributes: ['id', 'title'] });
        await notifyAssigned({ task, checklist, actorId: userId, channels });
    }
    return getTask({ id: task.id });
}

export async function setTaskStatus({ id, statusId, userId }) {
    const task = await db.ChecklistTask.findByPk(Number(id));
    if (!task) throw new Error('Tarefa não encontrada.');
    const statusMap = await loadStatusMap();
    const prevSc = task.status_id ? statusMap.get(task.status_id)?.state_class : 'TODO';
    const newSc = statusId ? statusMap.get(Number(statusId))?.state_class : 'TODO';
    task.status_id = statusId || null;
    task.updated_by = userId || null;
    if (newSc === 'DONE' && prevSc !== 'DONE') task.completed_at = new Date();
    if (newSc !== 'DONE') task.completed_at = null;
    await task.save();
    await recomputeProgress(task.checklist_id);
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: 'status_changed', meta: { to: statusId, state_class: newSc } });
    if (newSc === 'DONE' && prevSc !== 'DONE') await notifyCompleted({ task, actorId: userId });
    return { ok: true, id: task.id, status_id: task.status_id, state_class: newSc, completed_at: task.completed_at };
}

export async function reorderTasks({ items = [], userId }) {
    if (!Array.isArray(items)) throw new Error('items deve ser um array.');
    for (const it of items) {
        const patch = {};
        if ('section_id' in it) patch.section_id = it.section_id;
        if ('position' in it) patch.position = it.position;
        if (Object.keys(patch).length) await db.ChecklistTask.update(patch, { where: { id: Number(it.id) } });
    }
    return { ok: true };
}

export async function removeTask({ id, userId }) {
    const task = await db.ChecklistTask.findByPk(Number(id), { attributes: ['id', 'checklist_id'] });
    if (!task) throw new Error('Tarefa não encontrada.');
    const checklistId = task.checklist_id;
    await db.ChecklistTask.destroy({ where: { [Op.or]: [{ id: task.id }, { parent_task_id: task.id }] } }); // leva subtarefas junto
    await recomputeProgress(checklistId);
    await logActivity({ checklistId, userId, action: 'task.removed' });
    return { ok: true };
}

export async function nudgeTask({ id, userId, message, channels }) {
    const task = await db.ChecklistTask.findByPk(Number(id));
    if (!task) throw new Error('Tarefa não encontrada.');
    if (!task.assignee_user_id) throw new Error('Tarefa sem responsável vinculado para cobrar.');
    const checklist = await db.Checklist.findByPk(task.checklist_id, { attributes: ['id', 'title'] });
    // Cobrança é ação explícita: bypass de preferência, usa os canais escolhidos.
    const ch = channels || { inapp: true, email: true, whatsapp: true };
    try {
        await NotificationService.notify({
            type: NotificationType.CHECKLIST_TASK_NUDGE,
            recipients: { users: [task.assignee_user_id] },
            title: `Cobrança: ${task.title}`,
            body: message || checklist?.title || null,
            data: { checklistId: task.checklist_id, taskId: task.id },
            link: `/checklists/${task.checklist_id}?task=${task.id}`,
            importance: 8,
            channels: ch,
            bypassPrefs: true,
            whatsappData: {
                userName: '', taskTitle: task.title, checklistTitle: checklist?.title || '',
                dueDateFormatted: task.due_date ? dayjs(task.due_date).format('DD/MM/YYYY') : '',
            },
        });
    } catch (err) { console.warn('[checklist.nudge]', err?.message || err); }
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: 'nudge.sent', meta: { to: task.assignee_user_id, channels: ch } });
    return { ok: true };
}

// ── Comentários ───────────────────────────────────────────────────────────────

export async function listComments({ taskId }) {
    const rows = await db.ChecklistTaskComment.findAll({
        where: { task_id: taskId },
        include: [{ association: 'author', attributes: ['id', 'username'], required: false }],
        order: [['created_at', 'ASC']],
    });
    return rows.map((r) => r.get({ plain: true }));
}

export async function addComment({ taskId, body, userId }) {
    if (!body || !body.trim()) throw new Error('Comentário vazio.');
    const task = await db.ChecklistTask.findByPk(Number(taskId), { attributes: ['id', 'checklist_id', 'title', 'assignee_user_id'] });
    if (!task) throw new Error('Tarefa não encontrada.');
    const comment = await db.ChecklistTaskComment.create({ task_id: task.id, user_id: userId, body: body.trim() });
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: 'comment.added' });
    await notifyComment({ task, body, actorId: userId });
    const withAuthor = await db.ChecklistTaskComment.findByPk(comment.id, { include: [{ association: 'author', attributes: ['id', 'username'], required: false }] });
    return withAuthor.get({ plain: true });
}

export async function removeComment({ id, userId, isAdmin = false }) {
    const c = await db.ChecklistTaskComment.findByPk(Number(id));
    if (!c) throw new Error('Comentário não encontrado.');
    if (!isAdmin && c.user_id !== userId) throw new Error('Só o autor pode remover o comentário.');
    await c.destroy();
    return { ok: true };
}

// ── Anexos (metadados; o upload em si vai por /api/uploads) ────────────────────

export async function addAttachment({ taskId, payload = {}, userId }) {
    const task = await db.ChecklistTask.findByPk(Number(taskId), { attributes: ['id', 'checklist_id'] });
    if (!task) throw new Error('Tarefa não encontrada.');
    if (!payload.url || !payload.file_name) throw new Error('url e file_name são obrigatórios.');
    // kind explícito (LINK = link externo: SharePoint, drive, etc.) ou auto pelo mime.
    const explicitKind = ['LINK', 'IMAGE', 'FILE'].includes(payload.kind) ? payload.kind : null;
    const isImage = String(payload.mime_type || '').startsWith('image/');
    const att = await db.ChecklistTaskAttachment.create({
        task_id: task.id,
        file_name: payload.file_name,
        mime_type: payload.mime_type || null,
        url: payload.url,
        storage_path: payload.storage_path || null,
        size: payload.size || null,
        kind: explicitKind || (isImage ? 'IMAGE' : 'FILE'),
        uploaded_by: userId || null,
    });
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: 'attachment.added', meta: { file: payload.file_name } });
    return att.get({ plain: true });
}

export async function removeAttachment({ id }) {
    const att = await db.ChecklistTaskAttachment.findByPk(Number(id));
    if (!att) throw new Error('Anexo não encontrado.');
    await att.destroy();
    return { ok: true };
}

// ── Bulk / edição em cascata ──────────────────────────────────────────────────
export async function bulkUpdate({ ids = [], patch = {}, userId }) {
    const numIds = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
    if (!numIds.length) return { ok: true, updated: 0 };

    const tasks = await db.ChecklistTask.findAll({ where: { id: numIds }, attributes: ['id', 'checklist_id', 'due_date'] });
    const checklistIds = new Set(tasks.map((t) => t.checklist_id));

    if (patch.delete) {
        await db.ChecklistTask.destroy({ where: { [Op.or]: [{ id: numIds }, { parent_task_id: numIds }] } });
        for (const cid of checklistIds) await recomputeProgress(cid);
        for (const cid of checklistIds) await logActivity({ checklistId: cid, userId, action: 'task.bulk_removed', meta: { count: numIds.length } });
        return { ok: true, updated: numIds.length, deleted: true };
    }

    // Deslocamento de prazos em cascata (re-planejamento de várias tarefas).
    if (patch.shiftDays) {
        for (const t of tasks) {
            if (t.due_date) {
                await db.ChecklistTask.update(
                    { due_date: dayjs(t.due_date).add(Number(patch.shiftDays), 'day').format('YYYY-MM-DD'), updated_by: userId || null },
                    { where: { id: t.id } },
                );
            }
        }
    }

    // Campos uniformes aplicados a todos os selecionados.
    const allowed = ['section_id', 'category', 'status_id', 'priority', 'due_date', 'contracted_at', 'assignee_user_id', 'assignee_label', 'value', 'value_kind'];
    const data = {};
    for (const f of allowed) if (f in patch) data[f] = patch[f];
    if (Object.keys(data).length) {
        if ('status_id' in data) {
            const statusMap = await loadStatusMap();
            const sc = data.status_id ? statusMap.get(Number(data.status_id))?.state_class : 'TODO';
            data.completed_at = sc === 'DONE' ? new Date() : null;
        }
        data.updated_by = userId || null;
        await db.ChecklistTask.update(data, { where: { id: numIds } });
    }

    for (const cid of checklistIds) await recomputeProgress(cid);
    for (const cid of checklistIds) await logActivity({ checklistId: cid, userId, action: 'task.bulk_updated', meta: { count: numIds.length, fields: Object.keys(patch) } });
    return { ok: true, updated: numIds.length };
}

export default {
    getTask, createTask, updateTask, setTaskStatus, reorderTasks, removeTask, nudgeTask, bulkUpdate,
    listComments, addComment, removeComment,
    addAttachment, removeAttachment,
};
