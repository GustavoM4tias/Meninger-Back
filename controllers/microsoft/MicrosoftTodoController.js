// controllers/microsoft/MicrosoftTodoController.js
//
// To Do PESSOAL. Opera app-only via microsoft_id do usuário logado (não exige
// reconexão Microsoft). O conteúdo vive no Graph; aqui só orquestramos as
// chamadas e mantemos o índice local (todo_task_refs) best-effort para o
// dashboard cross-list e os vínculos com reunião/empreendimento.
import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import todo from '../../services/microsoft/MicrosoftTodoService.js';

class MicrosoftTodoController {

    // Garante que o usuário tem conta Microsoft vinculada. Retorna o microsoft_id
    // ou null (já respondendo 401) — o caller deve abortar quando vier null.
    _msId(req, res) {
        const msId = req.user?.microsoft_id;
        if (!msId) {
            res.status(401).json({ error: 'Conta Microsoft não conectada. Vincule sua conta em Minha Conta.' });
            return null;
        }
        return msId;
    }

    _err(res, err, ctx) {
        console.error(`❌ [To Do] ${ctx}:`, err?.response?.data || err.message);
        return res.status(err?.response?.status || 500).json({ error: err.message });
    }

    // Atualiza o índice local a partir do objeto de tarefa do Graph. Best-effort:
    // nunca quebra a operação principal se o banco falhar.
    async _upsertRef(userId, listId, task) {
        try {
            if (!task?.id) return;
            const due = task.dueDateTime?.dateTime ? new Date(task.dueDateTime.dateTime) : null;
            const values = {
                ms_list_id: listId,
                title_cache: task.title || null,
                status_cache: task.status || null,
                due_cache: due,
                importance_cache: task.importance || null,
                last_synced_at: new Date(),
            };
            const ref = await db.TodoTaskRef.findOne({ where: { ms_task_id: task.id } });
            if (ref) await ref.update(values);
            else await db.TodoTaskRef.create({ user_id: userId, ms_task_id: task.id, ...values });
        } catch (e) {
            console.warn('[To Do] _upsertRef falhou (nao crítico):', e?.message || e);
        }
    }

    // Garante (e retorna) a linha de índice local de uma tarefa. Usado pelas
    // operações de anexo, que precisam do registro mesmo para tarefas criadas
    // fora do Office (direto no app To Do).
    async _ensureRef(userId, listId, taskId) {
        let ref = await db.TodoTaskRef.findOne({ where: { ms_task_id: taskId } });
        if (!ref) {
            ref = await db.TodoTaskRef.create({ user_id: userId, ms_task_id: taskId, ms_list_id: listId, attachments: [] });
        }
        return ref;
    }

    // ── Listas ──────────────────────────────────────────────────────────────────

    getLists = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try { return res.json(await todo.listLists(m)); }
        catch (err) { return this._err(res, err, 'getLists'); }
    };

    createList = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const { displayName } = req.body;
            if (!displayName) return res.status(400).json({ error: 'displayName é obrigatório.' });
            return res.status(201).json(await todo.createList(m, displayName));
        } catch (err) { return this._err(res, err, 'createList'); }
    };

    updateList = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try { return res.json(await todo.updateList(m, req.params.listId, req.body.displayName)); }
        catch (err) { return this._err(res, err, 'updateList'); }
    };

    deleteList = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try { await todo.deleteList(m, req.params.listId); return res.status(204).end(); }
        catch (err) { return this._err(res, err, 'deleteList'); }
    };

    // ── Tarefas ───────────────────────────────────────────────────────────────────

    getTasks = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try { return res.json(await todo.listTasks(m, req.params.listId)); }
        catch (err) { return this._err(res, err, 'getTasks'); }
    };

    getTask = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const task = await todo.getTask(m, req.params.listId, req.params.taskId);
            const ref = await db.TodoTaskRef.findOne({ where: { ms_task_id: req.params.taskId } });
            task.localAttachments = ref?.attachments || [];
            task.meeting = ref?.meeting_join_url
                ? { joinUrl: ref.meeting_join_url, subject: ref.meeting_subject, eventId: ref.meeting_event_id }
                : null;
            return res.json(task);
        } catch (err) { return this._err(res, err, 'getTask'); }
    };

    createTask = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const task = await todo.createTask(m, req.params.listId, req.body || {});
            await this._upsertRef(req.user.id, req.params.listId, task);
            return res.status(201).json(task);
        } catch (err) { return this._err(res, err, 'createTask'); }
    };

    updateTask = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const task = await todo.updateTask(m, req.params.listId, req.params.taskId, req.body || {});
            await this._upsertRef(req.user.id, req.params.listId, task);
            return res.json(task);
        } catch (err) { return this._err(res, err, 'updateTask'); }
    };

    completeTask = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const completed = req.body?.completed !== false; // default: concluir
            const task = await todo.setCompleted(m, req.params.listId, req.params.taskId, completed);
            await this._upsertRef(req.user.id, req.params.listId, task);
            return res.json(task);
        } catch (err) { return this._err(res, err, 'completeTask'); }
    };

    deleteTask = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            await todo.deleteTask(m, req.params.listId, req.params.taskId);
            await db.TodoTaskRef.destroy({ where: { ms_task_id: req.params.taskId } }).catch(() => {});
            return res.status(204).end();
        } catch (err) { return this._err(res, err, 'deleteTask'); }
    };

    // ── Etapas (subtarefas) ────────────────────────────────────────────────────────

    createStep = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const { displayName } = req.body;
            if (!displayName) return res.status(400).json({ error: 'displayName é obrigatório.' });
            return res.status(201).json(await todo.createStep(m, req.params.listId, req.params.taskId, displayName));
        } catch (err) { return this._err(res, err, 'createStep'); }
    };

    updateStep = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try { return res.json(await todo.updateStep(m, req.params.listId, req.params.taskId, req.params.stepId, req.body || {})); }
        catch (err) { return this._err(res, err, 'updateStep'); }
    };

    deleteStep = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try { await todo.deleteStep(m, req.params.listId, req.params.taskId, req.params.stepId); return res.status(204).end(); }
        catch (err) { return this._err(res, err, 'deleteStep'); }
    };

    // ── Anexos (vincular URL / arquivo / SharePoint) ───────────────────────────────
    // Lista canônica fica LOCAL (todo_task_refs.attachments) porque o To Do nativo
    // só guarda 1 linkedResource por tarefa. Aqui suportamos vários; o slot nativo
    // fica reservado para a reunião/Teams (Fase 2).

    addLink = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const { webUrl, displayName, kind } = req.body;
            if (!webUrl) return res.status(400).json({ error: 'webUrl é obrigatório.' });
            const ref = await this._ensureRef(req.user.id, req.params.listId, req.params.taskId);
            const list = Array.isArray(ref.attachments) ? [...ref.attachments] : [];
            const item = {
                id: crypto.randomUUID(),
                webUrl,
                displayName: displayName || webUrl,
                kind: kind || 'URL', // URL | FILE | SHAREPOINT | MEETING
                createdAt: new Date().toISOString(),
            };
            list.push(item);
            await ref.update({ attachments: list });
            return res.status(201).json(item);
        } catch (err) { return this._err(res, err, 'addLink'); }
    };

    deleteLink = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const ref = await db.TodoTaskRef.findOne({ where: { ms_task_id: req.params.taskId } });
            if (ref) {
                const list = (ref.attachments || []).filter((a) => a.id !== req.params.linkId);
                await ref.update({ attachments: list });
            }
            return res.status(204).end();
        } catch (err) { return this._err(res, err, 'deleteLink'); }
    };

    // ── Agregado "Minhas Tarefas" (todas as listas) + enriquecimento local ─────────

    myTasks = async (req, res) => {
        const m = this._msId(req, res); if (!m) return;
        try {
            const lists = await todo.listLists(m);
            const perList = await Promise.all(lists.map(async (l) => {
                const tasks = await todo.listTasks(m, l.id);
                return tasks.map((t) => ({ ...t, listId: l.id, listName: l.displayName }));
            }));
            const tasks = perList.flat();

            const ids = tasks.map((t) => t.id);
            let refByTask = {};
            if (ids.length) {
                const refs = await db.TodoTaskRef.findAll({ where: { ms_task_id: ids } });
                refByTask = Object.fromEntries(refs.map((r) => [r.ms_task_id, r]));
            }
            const enriched = tasks.map((t) => {
                const r = refByTask[t.id];
                return {
                    ...t,
                    attachmentsCount: r?.attachments?.length || 0,
                    meeting: r?.meeting_join_url
                        ? { joinUrl: r.meeting_join_url, subject: r.meeting_subject, eventId: r.meeting_event_id }
                        : null,
                };
            });
            return res.json({ lists, tasks: enriched });
        } catch (err) { return this._err(res, err, 'myTasks'); }
    };
}

export default new MicrosoftTodoController();
