// services/microsoft/MicrosoftTodoService.js
//
// Cliente do Microsoft To Do (Graph "Tasks") operando APP-ONLY: usa o token de
// aplicação (Tasks.ReadWrite.All, já consentido pelo admin) para ler/escrever na
// To Do de qualquer usuário via /users/{microsoft_id}/todo — sem login delegado,
// então ninguém precisa reconectar a conta Microsoft.
//
// O Microsoft é a FONTE DE VERDADE do conteúdo da tarefa. O enriquecimento local
// (vínculo com reunião/empreendimento) fica em todo_task_refs, fora deste serviço.

import graph from './MicrosoftGraphService.js';

const base = (msId) => `/users/${encodeURIComponent(msId)}/todo`;
const stripBase = (url) => url.replace('https://graph.microsoft.com/v1.0', '');

class MicrosoftTodoService {

    // Coleta todas as páginas de um endpoint de coleção do Graph.
    async _collect(firstPath) {
        const out = [];
        let path = firstPath;
        let guard = 0;
        while (path && guard++ < 50) {
            const data = await graph.appGet(path);
            if (Array.isArray(data?.value)) out.push(...data.value);
            const next = data?.['@odata.nextLink'];
            path = next ? stripBase(next) : null;
        }
        return out;
    }

    // ── Listas ────────────────────────────────────────────────────────────────

    listLists(msId) {
        return this._collect(`${base(msId)}/lists?$top=100`);
    }

    createList(msId, displayName) {
        return graph.appPost(`${base(msId)}/lists`, { displayName });
    }

    updateList(msId, listId, displayName) {
        return graph.appPatch(`${base(msId)}/lists/${listId}`, { displayName });
    }

    deleteList(msId, listId) {
        return graph.appDelete(`${base(msId)}/lists/${listId}`);
    }

    // ── Tarefas ─────────────────────────────────────────────────────────────────
    // $expand traz linkedResources (URLs/arquivos vinculados) e checklistItems
    // (etapas/subtarefas) numa só chamada — evita N+1 ao montar a lista.

    listTasks(msId, listId) {
        return this._collect(
            `${base(msId)}/lists/${listId}/tasks?$expand=linkedResources,checklistItems&$top=100`
        );
    }

    getTask(msId, listId, taskId) {
        return graph.appGet(
            `${base(msId)}/lists/${listId}/tasks/${taskId}?$expand=linkedResources,checklistItems`
        );
    }

    createTask(msId, listId, payload) {
        return graph.appPost(`${base(msId)}/lists/${listId}/tasks`, payload);
    }

    updateTask(msId, listId, taskId, patch) {
        return graph.appPatch(`${base(msId)}/lists/${listId}/tasks/${taskId}`, patch);
    }

    deleteTask(msId, listId, taskId) {
        return graph.appDelete(`${base(msId)}/lists/${listId}/tasks/${taskId}`);
    }

    // Atalho de concluir/reabrir.
    setCompleted(msId, listId, taskId, completed) {
        return this.updateTask(msId, listId, taskId, {
            status: completed ? 'completed' : 'notStarted',
        });
    }

    // ── Etapas (checklistItems / subtarefas) ─────────────────────────────────────

    createStep(msId, listId, taskId, displayName) {
        return graph.appPost(
            `${base(msId)}/lists/${listId}/tasks/${taskId}/checklistItems`,
            { displayName }
        );
    }

    updateStep(msId, listId, taskId, stepId, patch) {
        return graph.appPatch(
            `${base(msId)}/lists/${listId}/tasks/${taskId}/checklistItems/${stepId}`,
            patch
        );
    }

    deleteStep(msId, listId, taskId, stepId) {
        return graph.appDelete(
            `${base(msId)}/lists/${listId}/tasks/${taskId}/checklistItems/${stepId}`
        );
    }

    // ── linkedResources (vincular URL / arquivo / SharePoint) ────────────────────
    // To Do não guarda binário: o anexo é sempre um link (webUrl). Arquivo local
    // entra subindo ao bucket/SharePoint antes e vinculando a URL resultante.

    addLink(msId, listId, taskId, { webUrl, displayName, applicationName = 'Menin Office' }) {
        return graph.appPost(
            `${base(msId)}/lists/${listId}/tasks/${taskId}/linkedResources`,
            { webUrl, displayName: displayName || webUrl, applicationName }
        );
    }

    deleteLink(msId, listId, taskId, linkId) {
        return graph.appDelete(
            `${base(msId)}/lists/${listId}/tasks/${taskId}/linkedResources/${linkId}`
        );
    }

    // Remove TODOS os linkedResources nativos da tarefa (o To Do só aceita 1).
    async clearNativeLinks(msId, listId, taskId) {
        const task = await this.getTask(msId, listId, taskId);
        for (const lr of task?.linkedResources || []) {
            try { await this.deleteLink(msId, listId, taskId, lr.id); } catch { /* ignora */ }
        }
    }

    // Define o ÚNICO linkedResource nativo (usado para o link da reunião/Teams):
    // limpa os existentes e adiciona este.
    async setNativeLink(msId, listId, taskId, link) {
        await this.clearNativeLinks(msId, listId, taskId);
        return this.addLink(msId, listId, taskId, link);
    }

    // ── Agregação para o digest diário ────────────────────────────────────────────
    // Tarefas ABERTAS com prazo de todas as listas. Retorna o mínimo necessário:
    // { id, title, listName, dueStr } com dueStr no formato 'YYYY-MM-DD'.
    async aggregateOpenWithDue(msId) {
        const lists = await this.listLists(msId);
        const out = [];
        for (const l of lists) {
            let tasks = [];
            try { tasks = await this.listTasks(msId, l.id); } catch { continue; }
            for (const t of tasks) {
                if (t.status === 'completed') continue;
                const dt = t.dueDateTime?.dateTime;
                if (!dt) continue;
                out.push({ id: t.id, title: t.title || '(sem título)', listName: l.displayName, dueStr: dt.slice(0, 10) });
            }
        }
        return out;
    }
}

export default new MicrosoftTodoService();
