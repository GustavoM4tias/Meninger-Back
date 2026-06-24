// services/checklist/taskService.js
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { loadStatusMap, recomputeProgress, logActivity, parseMentions } from './lib.js';
import authProfileService from './authProfileService.js';

// Erros tipados do fluxo de autorização (o controller mapeia p/ HTTP 409).
function approvalRequiredError() { const e = new Error('Esta tarefa precisa de autorização antes de avançar. Envie para aprovação.'); e.code = 'APPROVAL_REQUIRED'; e.httpStatus = 409; return e; }
function lockedError() { const e = new Error('Tarefa em aprovação: edição bloqueada até a decisão.'); e.code = 'APPROVAL_LOCKED'; e.httpStatus = 409; return e; }
const statusById = (statusMap, id) => (id ? statusMap.get(Number(id)) : null);
const roleStatusId = (statusMap, role) => { for (const s of statusMap.values()) if (s.approval_role === role) return s.id; return null; };

// ── Notificações (best-effort, nunca lançam) ──────────────────────────────────

function assigneeIdsOf(task) {
    const arr = Array.isArray(task.assignee_user_ids) && task.assignee_user_ids.length
        ? task.assignee_user_ids
        : (task.assignee_user_id ? [task.assignee_user_id] : []);
    return [...new Set(arr.map(Number).filter(Boolean))];
}
// Normaliza os responsáveis vindos do payload (array assignee_user_ids ou single legado).
function assigneeIdsFromPayload(payload) {
    if (Array.isArray(payload.assignee_user_ids)) return [...new Set(payload.assignee_user_ids.map(Number).filter(Boolean))];
    if (payload.assignee_user_id) return [Number(payload.assignee_user_id)].filter(Boolean);
    return [];
}

async function notifyAssigned({ task, checklist, actorId, channels = null }) {
    try {
        const ids = assigneeIdsOf(task).filter((u) => u !== actorId);
        if (!ids.length) return;
        await NotificationService.notify({
            type: NotificationType.CHECKLIST_TASK_ASSIGNED,
            recipients: { users: ids },
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
        const recipients = new Set(assigneeIdsOf(task).filter((u) => u !== actorId));
        const mentions = parseMentions(body || '');
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

// Avisa os membros dos perfis exigidos que há uma tarefa aguardando autorização.
async function notifyApprovalRequested({ task, actorId }) {
    try {
        const userIds = (await authProfileService.approverUserIdsFor(task.auth_profile_ids || [])).filter((u) => u !== actorId);
        if (!userIds.length) return;
        const checklist = await db.Checklist.findByPk(task.checklist_id, { attributes: ['id', 'title'] });
        await NotificationService.notify({
            type: NotificationType.CHECKLIST_APPROVAL_REQUESTED,
            recipients: { users: userIds },
            title: `Autorização pendente: ${task.title}`,
            body: checklist?.title || null,
            data: { checklistId: task.checklist_id, taskId: task.id },
            link: `/checklists/${task.checklist_id}?task=${task.id}`,
            importance: 7,
        });
    } catch (err) { console.warn('[checklist.notifyApprovalRequested]', err?.message || err); }
}

// Avisa o responsável (e o dono do checklist) o resultado da autorização.
async function notifyApprovalDecided({ task, approved }) {
    try {
        const recipients = new Set();
        if (task.assignee_user_id) recipients.add(task.assignee_user_id);
        const checklist = await db.Checklist.findByPk(task.checklist_id, { attributes: ['id', 'title', 'owner_user_id'] });
        if (checklist?.owner_user_id) recipients.add(checklist.owner_user_id);
        if (!recipients.size) return;
        await NotificationService.notify({
            type: NotificationType.CHECKLIST_APPROVAL_DECIDED,
            recipients: { users: Array.from(recipients) },
            title: `${approved ? 'Aprovada' : 'Reprovada (ajustar)'}: ${task.title}`,
            body: checklist?.title || null,
            data: { checklistId: task.checklist_id, taskId: task.id },
            link: `/checklists/${task.checklist_id}?task=${task.id}`,
            importance: approved ? 6 : 7,
        });
    } catch (err) { console.warn('[checklist.notifyApprovalDecided]', err?.message || err); }
}

// ── Tarefas ───────────────────────────────────────────────────────────────────

export async function getTask({ id }) {
    const task = await db.ChecklistTask.findByPk(Number(id), {
        include: [{ association: 'assignee', attributes: ['id', 'username', 'email'], required: false }],
    });
    if (!task) throw new Error('Tarefa não encontrada.');
    const [attachments, comments, activity, subtasks, approvals, statusMap] = await Promise.all([
        db.ChecklistTaskAttachment.findAll({ where: { task_id: id }, order: [['created_at', 'DESC']] }),
        db.ChecklistTaskComment.findAll({ where: { task_id: id }, include: [{ association: 'author', attributes: ['id', 'username'], required: false }], order: [['created_at', 'ASC']] }),
        db.ChecklistActivity.findAll({ where: { task_id: id }, include: [{ association: 'actor', attributes: ['id', 'username'], required: false }], order: [['created_at', 'DESC']], limit: 50 }),
        db.ChecklistTask.findAll({ where: { parent_task_id: id }, order: [['position', 'ASC']] }),
        db.ChecklistTaskApproval.findAll({ where: { task_id: id }, include: [{ association: 'user', attributes: ['id', 'username'], required: false }], order: [['created_at', 'DESC']] }),
        loadStatusMap(),
    ]);
    const p = task.get({ plain: true });
    p.state_class = p.status_id ? (statusMap.get(p.status_id)?.state_class || 'TODO') : 'TODO';
    // Perfis exigidos (nome + membros) p/ o painel de aprovação ser auto-suficiente.
    const authProfiles = (p.auth_profile_ids || []).length
        ? await authProfileService.profilesByIds(p.auth_profile_ids)
        : [];
    // Responsáveis resolvidos (1+ pessoas).
    const aIds = assigneeIdsOf(p);
    const assignees = aIds.length
        ? await db.User.findAll({ where: { id: aIds }, attributes: ['id', 'username', 'email'], raw: true })
        : [];
    return {
        task: p,
        attachments: attachments.map((a) => a.get({ plain: true })),
        comments: comments.map((c) => c.get({ plain: true })),
        activity: activity.map((a) => a.get({ plain: true })),
        subtasks: subtasks.map((s) => s.get({ plain: true })),
        approvals: approvals.map((a) => a.get({ plain: true })),
        authProfiles,
        assignees,
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
        assignee_user_id: assigneeIdsFromPayload(payload)[0] || null,
        assignee_user_ids: assigneeIdsFromPayload(payload),
        assignee_label: payload.assignee_label || null,
        checklist_items: Array.isArray(payload.checklist_items) ? payload.checklist_items : [],
        needs_authorization: !!payload.needs_authorization,
        auth_profile_ids: Array.isArray(payload.auth_profile_ids) ? payload.auth_profile_ids : [],
        position: payload.position ?? ((Number(max) || 0) + 10),
        created_by: userId || null,
        updated_by: userId || null,
    });
    await recomputeProgress(checklist.id);
    await logActivity({ checklistId: checklist.id, taskId: task.id, userId, action: 'task.created', meta: { title: task.title } });
    if (payload.notify !== false && task.assignee_user_id) await notifyAssigned({ task, checklist, actorId: userId, channels: payload.channels || null });
    return getTask({ id: task.id });
}

export async function updateTask({ id, payload = {}, userId, isAdmin = false }) {
    const task = await db.ChecklistTask.findByPk(Number(id));
    if (!task) throw new Error('Tarefa não encontrada.');
    // Lock: em aprovação (PENDING) a edição de campos fica bloqueada (só a decisão age).
    if (task.approval_status === 'PENDING') throw lockedError();

    // Permissão por papel: usuário normal só edita anotações, etapa e subtarefas
    // (anexos/comentários têm endpoints próprios). Admin edita tudo. Campos fora do
    // permitido são ignorados em silêncio (não bloqueiam a edição válida).
    const ADMIN_FIELDS = ['section_id', 'parent_task_id', 'category', 'title', 'priority', 'value', 'value_kind', 'contracted_at', 'due_date', 'started_at', 'assignee_user_id', 'assignee_user_ids', 'assignee_label', 'needs_authorization', 'auth_profile_ids', 'position'];
    const USER_FIELDS = ['description', 'status_id', 'checklist_items'];
    const allowed = isAdmin ? [...ADMIN_FIELDS, ...USER_FIELDS] : USER_FIELDS;

    const prevIds = assigneeIdsOf(task);
    const wantsNotify = payload.notify === true;
    const silent = payload.notify === false;
    const channels = payload.channels || null;

    // Responsáveis (só admin): mantém assignee_user_id primário sincronizado.
    if (isAdmin && ('assignee_user_ids' in payload || 'assignee_user_id' in payload)) {
        const ids = assigneeIdsFromPayload(payload);
        task.assignee_user_ids = ids;
        task.assignee_user_id = ids[0] || null;
    }
    for (const f of allowed) if (f in payload && f !== 'assignee_user_id' && f !== 'assignee_user_ids') task[f] = payload[f];

    // Gating de autorização (qualquer papel): status "barrado" exige aprovação prévia.
    let statusMap = null;
    if ('status_id' in payload && allowed.includes('status_id')) {
        statusMap = await loadStatusMap();
        const target = statusById(statusMap, task.status_id);
        if (target?.requires_approval && task.needs_authorization && task.approval_status !== 'APPROVED') throw approvalRequiredError();
    }

    const changedFields = (task.changed() || []).filter((f) => f !== 'updated_at' && f !== 'updated_by');
    const changes = {};
    for (const f of changedFields) changes[f] = { from: task.previous(f) ?? null, to: task[f] ?? null };
    task.updated_by = userId || null;

    if ('status_id' in payload && statusMap) {
        const sc = task.status_id ? statusMap.get(task.status_id)?.state_class : 'TODO';
        if (sc === 'DONE' && !task.completed_at) task.completed_at = new Date();
        if (sc !== 'DONE') task.completed_at = null;
    }
    await task.save();
    await recomputeProgress(task.checklist_id);
    if (changedFields.length) await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: 'task.updated', meta: { fields: changedFields, changes } });

    const newIds = assigneeIdsOf(task);
    const assigneeChanged = JSON.stringify([...prevIds].sort()) !== JSON.stringify([...newIds].sort());
    if (newIds.length && (wantsNotify || (!silent && assigneeChanged))) {
        const checklist = await db.Checklist.findByPk(task.checklist_id, { attributes: ['id', 'title'] });
        await notifyAssigned({ task, checklist, actorId: userId, channels });
    }
    return getTask({ id: task.id });
}

export async function setTaskStatus({ id, statusId, userId }) {
    const task = await db.ChecklistTask.findByPk(Number(id));
    if (!task) throw new Error('Tarefa não encontrada.');
    const statusMap = await loadStatusMap();
    // Em aprovação: bloqueia mudança manual de status (só a decisão move).
    if (task.approval_status === 'PENDING') throw lockedError();
    // Gating: status "barrado" exige aprovação prévia.
    const target = statusId ? statusMap.get(Number(statusId)) : null;
    if (target?.requires_approval && task.needs_authorization && task.approval_status !== 'APPROVED') throw approvalRequiredError();
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

export async function addComment({ taskId, body, image_url = null, annotated_from_id = null, userId }) {
    const text = (body || '').trim();
    if (!text && !image_url) throw new Error('Comentário vazio.');
    const task = await db.ChecklistTask.findByPk(Number(taskId), { attributes: ['id', 'checklist_id', 'title', 'assignee_user_id', 'assignee_user_ids'] });
    if (!task) throw new Error('Tarefa não encontrada.');
    const comment = await db.ChecklistTaskComment.create({
        task_id: task.id, user_id: userId, body: text || null,
        image_url: image_url || null, annotated_from_id: annotated_from_id || null,
    });
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: image_url ? 'comment.annotated' : 'comment.added' });
    await notifyComment({ task, body: text, actorId: userId });
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
        annotated_from_id: payload.annotated_from_id || null,
        uploaded_by: userId || null,
    });
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: payload.annotated_from_id ? 'attachment.annotated' : 'attachment.added', meta: { file: payload.file_name } });
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

    const tasks = await db.ChecklistTask.findAll({ where: { id: numIds }, attributes: ['id', 'checklist_id', 'due_date', 'needs_authorization', 'approval_status'] });
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

    // Campos uniformes aplicados aos selecionados.
    const allowed = ['section_id', 'category', 'status_id', 'priority', 'due_date', 'contracted_at', 'assignee_user_id', 'assignee_label', 'value', 'value_kind'];
    const data = {};
    for (const f of allowed) if (f in patch) data[f] = patch[f];
    // Atribuição em lote sincroniza o array de responsáveis (multi-responsável).
    if ('assignee_user_id' in data) data.assignee_user_ids = data.assignee_user_id ? [Number(data.assignee_user_id)] : [];
    if (Object.keys(data).length) {
        let targetIds = numIds;
        if ('status_id' in data) {
            const statusMap = await loadStatusMap();
            const target = data.status_id ? statusMap.get(Number(data.status_id)) : null;
            data.completed_at = (target?.state_class === 'DONE') ? new Date() : null;
            // Gating: tarefas que exigem autorização (e não aprovadas) NÃO entram em status barrado.
            if (target?.requires_approval) {
                const blocked = tasks.filter((t) => t.needs_authorization && t.approval_status !== 'APPROVED').map((t) => t.id);
                if (blocked.length) {
                    const { status_id, completed_at, ...rest } = data;
                    if (Object.keys(rest).length) { rest.updated_by = userId || null; await db.ChecklistTask.update(rest, { where: { id: blocked } }); }
                    targetIds = numIds.filter((id) => !blocked.includes(id));
                }
            }
        }
        if (targetIds.length) { data.updated_by = userId || null; await db.ChecklistTask.update(data, { where: { id: targetIds } }); }
    }

    for (const cid of checklistIds) await recomputeProgress(cid);
    for (const cid of checklistIds) await logActivity({ checklistId: cid, userId, action: 'task.bulk_updated', meta: { count: numIds.length, fields: Object.keys(patch) } });
    return { ok: true, updated: numIds.length };
}

// ── Autorização / aprovação (proofing) ─────────────────────────────────────────

// Executor envia a tarefa para aprovação (entra em "Em Aprovação", round++).
export async function submitForApproval({ id, userId }) {
    const task = await db.ChecklistTask.findByPk(Number(id));
    if (!task) throw new Error('Tarefa não encontrada.');
    if (!task.needs_authorization || !(task.auth_profile_ids || []).length) {
        throw new Error('Defina ao menos um perfil de autorização nesta tarefa antes de enviar.');
    }
    const statusMap = await loadStatusMap();
    const reviewId = roleStatusId(statusMap, 'REVIEW');
    task.approval_round = (task.approval_round || 0) + 1;
    task.approval_status = 'PENDING';
    if (reviewId) task.status_id = reviewId;
    task.completed_at = null;
    task.updated_by = userId || null;
    await task.save();
    await recomputeProgress(task.checklist_id);
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: 'approval.requested', meta: { round: task.approval_round, profiles: task.auth_profile_ids } });
    await notifyApprovalRequested({ task, actorId: userId });
    return getTask({ id: task.id });
}

// Um aprovador (membro de um perfil exigido) decide aprovar/reprovar.
export async function decideApproval({ id, profileId, decision, comment, userId }) {
    const task = await db.ChecklistTask.findByPk(Number(id));
    if (!task) throw new Error('Tarefa não encontrada.');
    if (task.approval_status !== 'PENDING') throw new Error('Esta tarefa não está em aprovação.');
    const pid = Number(profileId);
    if (!(task.auth_profile_ids || []).map(Number).includes(pid)) throw new Error('Perfil não exigido por esta tarefa.');
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw new Error('Decisão inválida.');
    const [profile] = await authProfileService.profilesByIds([pid]);
    if (!profile || !(profile.user_ids || []).map(Number).includes(Number(userId))) throw new Error('Você não faz parte deste perfil.');

    // Uma decisão por usuário/perfil/round (regrava se decidir de novo).
    await db.ChecklistTaskApproval.destroy({ where: { task_id: task.id, profile_id: pid, user_id: Number(userId), round: task.approval_round } });
    await db.ChecklistTaskApproval.create({ task_id: task.id, profile_id: pid, user_id: Number(userId), round: task.approval_round, decision, comment: comment?.trim() || null });
    await logActivity({ checklistId: task.checklist_id, taskId: task.id, userId, action: decision === 'APPROVED' ? 'approval.approved' : 'approval.rejected', meta: { profileId: pid, comment: comment?.trim() || null } });
    await recomputeApproval(task);
    return getTask({ id: task.id });
}

// Recalcula o estado de aprovação no round atual. Perfil aprovado = TODOS os membros
// aprovaram. Qualquer reprovação → REJECTED (volta p/ "Em Ajuste").
async function recomputeApproval(task) {
    const round = task.approval_round;
    const profiles = await authProfileService.profilesByIds(task.auth_profile_ids || []);
    const decisions = await db.ChecklistTaskApproval.findAll({ where: { task_id: task.id, round }, raw: true });

    const anyReject = decisions.some((d) => d.decision === 'REJECTED');
    let decided = null; // 'APPROVED' | 'REJECTED' | null (segue pendente)
    if (anyReject) {
        decided = 'REJECTED';
    } else {
        const approved = new Set(decisions.filter((d) => d.decision === 'APPROVED').map((d) => `${d.profile_id}:${Number(d.user_id)}`));
        const allApproved = profiles.length > 0 && profiles.every((p) => (p.user_ids || []).length > 0 && (p.user_ids || []).every((uid) => approved.has(`${p.id}:${Number(uid)}`)));
        if (allApproved) decided = 'APPROVED';
    }

    if (decided === 'REJECTED') {
        task.approval_status = 'REJECTED';
        const statusMap = await loadStatusMap();
        const reworkId = roleStatusId(statusMap, 'REWORK');
        if (reworkId) task.status_id = reworkId;
    } else if (decided === 'APPROVED') {
        task.approval_status = 'APPROVED';
    } else {
        task.approval_status = 'PENDING';
    }
    await task.save();
    await recomputeProgress(task.checklist_id);
    if (decided) await notifyApprovalDecided({ task, approved: decided === 'APPROVED' });
}

// Tarefas em aprovação que dependem de algum perfil do usuário (menu Aprovações).
export async function pendingApprovalsFor({ userId }) {
    const myProfiles = await authProfileService.profilesForUser(userId);
    const myProfileIds = myProfiles.map((p) => p.id);
    if (!myProfileIds.length) return [];
    const statusMap = await loadStatusMap();
    const rows = await db.ChecklistTask.findAll({
        where: { approval_status: 'PENDING' },
        include: [
            { association: 'assignee', attributes: ['id', 'username'], required: false },
            { association: 'checklist', attributes: ['id', 'title'], required: true, where: { status: { [Op.ne]: 'archived' } } },
        ],
        order: [['updated_at', 'DESC']],
    });
    const mine = rows.map((r) => r.get({ plain: true })).filter((t) => (t.auth_profile_ids || []).map(Number).some((id) => myProfileIds.includes(id)));
    if (!mine.length) return [];
    const taskIds = mine.map((t) => t.id);
    const myDecisions = await db.ChecklistTaskApproval.findAll({ where: { task_id: taskIds, user_id: Number(userId) }, raw: true });
    const decided = new Set(myDecisions.map((d) => `${d.task_id}:${d.round}:${d.profile_id}`));
    return mine.map((t) => {
        const myReq = (t.auth_profile_ids || []).map(Number).filter((id) => myProfileIds.includes(id));
        const awaitingMe = myReq.some((pid) => !decided.has(`${t.id}:${t.approval_round}:${pid}`));
        return {
            id: t.id, title: t.title, checklist_id: t.checklist_id,
            checklistTitle: t.checklist?.title || null,
            assignee: t.assignee?.username || t.assignee_label || null,
            due_date: t.due_date, status_label: t.status_id ? (statusMap.get(t.status_id)?.label || null) : null,
            auth_profile_ids: t.auth_profile_ids || [], awaitingMe,
        };
    });
}

export default {
    getTask, createTask, updateTask, setTaskStatus, reorderTasks, removeTask, nudgeTask, bulkUpdate,
    listComments, addComment, removeComment,
    addAttachment, removeAttachment,
    submitForApproval, decideApproval, pendingApprovalsFor,
};
