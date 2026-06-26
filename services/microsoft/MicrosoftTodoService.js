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
}

export default new MicrosoftTodoService();
