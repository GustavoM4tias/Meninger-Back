// services/microsoft/MicrosoftPlannerService.js
//
// Todas as operações PATCH e DELETE do Planner exigem o header "If-Match"
// com o @odata.etag do item. Aqui fazemos isso transparentemente.

import graphService from './MicrosoftGraphService.js';
import settingsService from './MicrosoftSettingsService.js';

class MicrosoftPlannerService {

    // ── Grupos Microsoft 365 ──────────────────────────────────────────────────

    async getMyGroups(user) {
        const cap = await settingsService.listCap();
        const { items } = await graphService.getAllPages(
            user, '/me/memberOf?$select=id,displayName,description,groupTypes&$top=100', undefined, { max: cap }
        );
        // Filtra apenas grupos Microsoft 365 (Unified) que têm Planner
        const groups = items.filter(g =>
            g['@odata.type'] === '#microsoft.graph.group' &&
            Array.isArray(g.groupTypes) && g.groupTypes.includes('Unified')
        );
        return groups;
    }

    // ── Plans ─────────────────────────────────────────────────────────────────

    async getGroupPlans(user, groupId) {
        const cap = await settingsService.listCap();
        const { items } = await graphService.getAllPages(user, `/groups/${groupId}/planner/plans`, undefined, { max: cap });
        return items;
    }

    async getPlan(user, planId) {
        return graphService.get(user, `/planner/plans/${planId}`);
    }

    async createPlan(user, groupId, title) {
        return graphService.post(user, '/planner/plans', { owner: groupId, title });
    }

    async updatePlan(user, planId, data, etag) {
        return graphService.call(user, 'patch', `/planner/plans/${planId}`, {
            data,
            headers: { 'If-Match': etag, Prefer: 'return=representation' },
        });
    }

    async deletePlan(user, planId, etag) {
        return graphService.call(user, 'delete', `/planner/plans/${planId}`, {
            headers: { 'If-Match': etag },
        });
    }

    // ── Buckets ───────────────────────────────────────────────────────────────

    async getPlanBuckets(user, planId) {
        const cap = await settingsService.listCap();
        const { items } = await graphService.getAllPages(user, `/planner/plans/${planId}/buckets`, undefined, { max: cap });
        return items;
    }

    async createBucket(user, planId, name, orderHint = ' !') {
        return graphService.post(user, '/planner/buckets', { planId, name, orderHint });
    }

    async updateBucket(user, bucketId, data, etag) {
        return graphService.call(user, 'patch', `/planner/buckets/${bucketId}`, {
            data,
            headers: { 'If-Match': etag, Prefer: 'return=representation' },
        });
    }

    async deleteBucket(user, bucketId, etag) {
        return graphService.call(user, 'delete', `/planner/buckets/${bucketId}`, {
            headers: { 'If-Match': etag },
        });
    }

    // ── Tasks ─────────────────────────────────────────────────────────────────

    async getPlanTasks(user, planId) {
        const cap = await settingsService.listCap();
        const { items } = await graphService.getAllPages(user, `/planner/plans/${planId}/tasks`, undefined, { max: cap });
        return items;
    }

    async getTask(user, taskId) {
        return graphService.get(user, `/planner/tasks/${taskId}`);
    }

    async getTaskDetails(user, taskId) {
        return graphService.get(user, `/planner/tasks/${taskId}/details`);
    }

    async createTask(user, data) {
        // data: { planId, bucketId, title, dueDateTime?, assignments?, priority? }
        return graphService.post(user, '/planner/tasks', data);
    }

    async updateTask(user, taskId, data, etag) {
        return graphService.call(user, 'patch', `/planner/tasks/${taskId}`, {
            data,
            headers: { 'If-Match': etag, Prefer: 'return=representation' },
        });
    }

    async deleteTask(user, taskId, etag) {
        return graphService.call(user, 'delete', `/planner/tasks/${taskId}`, {
            headers: { 'If-Match': etag },
        });
    }

    async updateTaskDetails(user, taskId, data, etag) {
        return graphService.call(user, 'patch', `/planner/tasks/${taskId}/details`, {
            data,
            headers: { 'If-Match': etag, Prefer: 'return=representation' },
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Carrega o plano completo: buckets + tasks em paralelo
    async getPlanFull(user, planId) {
        const [buckets, tasks] = await Promise.all([
            this.getPlanBuckets(user, planId),
            this.getPlanTasks(user, planId),
        ]);
        return { buckets, tasks };
    }

    // Monta o objeto de assignment para criar/atualizar tarefa
    buildAssignment(userId) {
        return {
            [userId]: {
                '@odata.type': '#microsoft.graph.plannerAssignment',
                orderHint: ' !',
            },
        };
    }

    /**
     * Monta o payload de responsáveis para um PATCH de tarefa.
     *
     * O Planner não aceita "substituir a lista": quem sai precisa vir no corpo
     * com valor null. Sem isso, remover responsável não funcionava — só somava.
     *
     * @param {object}   current  - assignments que a tarefa tem hoje (do Graph)
     * @param {string[]} desired  - microsoft_ids que devem ficar
     */
    buildAssignments(current = {}, desired = []) {
        const keep = new Set((desired || []).filter(Boolean));
        const payload = {};

        for (const id of keep) {
            if (!current?.[id]) {
                payload[id] = { '@odata.type': '#microsoft.graph.plannerAssignment', orderHint: ' !' };
            }
        }
        for (const id of Object.keys(current || {})) {
            if (!keep.has(id)) payload[id] = null; // null = tira o responsável
        }

        return payload;
    }

    // Mapeia priority numérica (0-9) para label
    priorityLabel(priority) {
        if (priority <= 1) return 'Urgente';
        if (priority <= 3) return 'Importante';
        if (priority <= 6) return 'Médio';
        return 'Baixo';
    }
}

export default new MicrosoftPlannerService();
