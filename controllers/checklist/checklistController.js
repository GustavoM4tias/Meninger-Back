// controllers/checklist/checklistController.js
import checklistService from '../../services/checklist/checklistService.js';
import templateService from '../../services/checklist/templateService.js';
import taskService from '../../services/checklist/taskService.js';
import importService from '../../services/checklist/importService.js';
import cobrancaService from '../../services/checklist/cobrancaService.js';
import authProfileService from '../../services/checklist/authProfileService.js';

const fail = (res, err, code = 400, ctx = '') => {
    console.error(`[checklist.${ctx}]`, err);
    const status = err?.httpStatus || code;
    // err.code (ex.: APPROVAL_REQUIRED, APPROVAL_LOCKED) deixa o front reagir.
    return res.status(status).json({ message: err?.message || 'Erro inesperado.', code: err?.code });
};
const isAdminReq = (req) => req.user?.role === 'admin';

const checklistController = {
    // ── Checklists ──
    async list(req, res) {
        try {
            return res.json(await checklistService.listChecklists({
                status: req.query.status,
                idempreendimento: req.query.idempreendimento,
                ownerUserId: req.query.ownerUserId,
                requesterId: req.user?.id,
                isAdmin: isAdminReq(req),
            }));
        } catch (err) { return fail(res, err, 400, 'list'); }
    },
    async dashboard(req, res) {
        try { return res.json(await checklistService.dashboard({ userId: req.user?.id, isAdmin: isAdminReq(req) })); }
        catch (err) { return fail(res, err, 400, 'dashboard'); }
    },
    async myTasks(req, res) {
        try { return res.json(await checklistService.myTasks({ userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'myTasks'); }
    },
    async getOne(req, res) {
        try { return res.json(await checklistService.getChecklistFull({ id: req.params.id, requesterId: req.user?.id, isAdmin: isAdminReq(req) })); }
        catch (err) { return fail(res, err, err?.httpStatus || 404, 'getOne'); }
    },
    async create(req, res) {
        try { return res.status(201).json(await checklistService.createChecklist({ payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'create'); }
    },
    async update(req, res) {
        try { return res.json(await checklistService.updateChecklist({ id: req.params.id, payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'update'); }
    },
    async archive(req, res) {
        try { return res.json(await checklistService.archiveChecklist({ id: req.params.id, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'archive'); }
    },
    async clone(req, res) {
        try { return res.status(201).json(await checklistService.cloneChecklist({ id: req.params.id, userId: req.user?.id, title: req.body?.title })); }
        catch (err) { return fail(res, err, 400, 'clone'); }
    },
    async remove(req, res) {
        try { return res.json(await checklistService.deleteChecklist({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'remove'); }
    },

    // ── Seções ──
    async addSection(req, res) {
        try { return res.status(201).json(await checklistService.addSection({ checklistId: req.params.id, payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'addSection'); }
    },
    async updateSection(req, res) {
        try { return res.json(await checklistService.updateSection({ id: req.params.id, payload: req.body || {} })); }
        catch (err) { return fail(res, err, 400, 'updateSection'); }
    },
    async removeSection(req, res) {
        try { return res.json(await checklistService.removeSection({ id: req.params.id, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'removeSection'); }
    },

    // ── Catálogo de status ──
    async listStatuses(req, res) {
        try { return res.json(await checklistService.listStatuses({ templateId: req.query.templateId })); }
        catch (err) { return fail(res, err, 400, 'listStatuses'); }
    },
    async createStatus(req, res) {
        try { return res.status(201).json(await checklistService.createStatus({ payload: req.body || {} })); }
        catch (err) { return fail(res, err, 400, 'createStatus'); }
    },
    async updateStatus(req, res) {
        try { return res.json(await checklistService.updateStatus({ id: req.params.id, payload: req.body || {} })); }
        catch (err) { return fail(res, err, 400, 'updateStatus'); }
    },
    async removeStatus(req, res) {
        try { return res.json(await checklistService.removeStatus({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'removeStatus'); }
    },

    // ── Modelos ──
    async listTemplates(req, res) {
        try { return res.json(await templateService.listTemplates({ includeInactive: req.query.includeInactive === 'true' })); }
        catch (err) { return fail(res, err, 400, 'listTemplates'); }
    },
    async getTemplate(req, res) {
        try { return res.json(await templateService.getTemplate({ id: req.params.id })); }
        catch (err) { return fail(res, err, 404, 'getTemplate'); }
    },
    async instantiate(req, res) {
        try { return res.status(201).json(await templateService.instantiate({ templateId: req.params.id, payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'instantiate'); }
    },
    // ── Edição de modelos (admin) ──
    async createTemplate(req, res) {
        try { return res.status(201).json(await templateService.createTemplate({ payload: req.body || {} })); }
        catch (err) { return fail(res, err, 400, 'createTemplate'); }
    },
    async updateTemplate(req, res) {
        try { return res.json(await templateService.updateTemplate({ id: req.params.id, payload: req.body || {} })); }
        catch (err) { return fail(res, err, 400, 'updateTemplate'); }
    },
    async deleteTemplate(req, res) {
        try { return res.json(await templateService.deleteTemplate({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'deleteTemplate'); }
    },
    async saveTemplateSection(req, res) {
        try { return res.json(await templateService.saveTemplateSection({ templateId: req.params.id, payload: req.body || {} })); }
        catch (err) { return fail(res, err, 400, 'saveTemplateSection'); }
    },
    async removeTemplateSection(req, res) {
        try { return res.json(await templateService.removeTemplateSection({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'removeTemplateSection'); }
    },
    async saveTemplateItem(req, res) {
        try { return res.json(await templateService.saveTemplateItem({ templateId: req.params.id, payload: req.body || {} })); }
        catch (err) { return fail(res, err, 400, 'saveTemplateItem'); }
    },
    async removeTemplateItem(req, res) {
        try { return res.json(await templateService.removeTemplateItem({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'removeTemplateItem'); }
    },

    // ── Tarefas ──
    async getTask(req, res) {
        try { return res.json(await taskService.getTask({ id: req.params.id })); }
        catch (err) { return fail(res, err, 404, 'getTask'); }
    },
    async createTask(req, res) {
        try { return res.status(201).json(await taskService.createTask({ checklistId: req.params.id, payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'createTask'); }
    },
    async updateTask(req, res) {
        try { return res.json(await taskService.updateTask({ id: req.params.id, payload: req.body || {}, userId: req.user?.id, isAdmin: isAdminReq(req) })); }
        catch (err) { return fail(res, err, 400, 'updateTask'); }
    },
    async setTaskStatus(req, res) {
        try { return res.json(await taskService.setTaskStatus({ id: req.params.id, statusId: req.body?.status_id, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'setTaskStatus'); }
    },
    async reorderTasks(req, res) {
        try { return res.json(await taskService.reorderTasks({ items: req.body?.items, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'reorderTasks'); }
    },
    async removeTask(req, res) {
        try { return res.json(await taskService.removeTask({ id: req.params.id, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'removeTask'); }
    },
    async nudgeTask(req, res) {
        try { return res.json(await taskService.nudgeTask({ id: req.params.id, userId: req.user?.id, message: req.body?.message, channels: req.body?.channels })); }
        catch (err) { return fail(res, err, 400, 'nudgeTask'); }
    },

    // ── Comentários ──
    async listComments(req, res) {
        try { return res.json(await taskService.listComments({ taskId: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'listComments'); }
    },
    async addComment(req, res) {
        try { return res.status(201).json(await taskService.addComment({ taskId: req.params.id, body: req.body?.body, image_url: req.body?.image_url, annotated_from_id: req.body?.annotated_from_id, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'addComment'); }
    },
    async removeComment(req, res) {
        try { return res.json(await taskService.removeComment({ id: req.params.id, userId: req.user?.id, isAdmin: req.user?.role === 'admin' })); }
        catch (err) { return fail(res, err, 400, 'removeComment'); }
    },

    // ── Anexos ──
    async addAttachment(req, res) {
        try { return res.status(201).json(await taskService.addAttachment({ taskId: req.params.id, payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'addAttachment'); }
    },
    async removeAttachment(req, res) {
        try { return res.json(await taskService.removeAttachment({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'removeAttachment'); }
    },

    // ── Usuários / Importação ──
    async listUsers(req, res) {
        try { return res.json(await checklistService.listUsers()); }
        catch (err) { return fail(res, err, 400, 'listUsers'); }
    },
    async listEnterprises(req, res) {
        try { return res.json(await checklistService.listEnterprises()); }
        catch (err) { return fail(res, err, 400, 'listEnterprises'); }
    },
    async importExcel(req, res) {
        try {
            if (!req.file) return res.status(400).json({ message: 'Arquivo não enviado.' });
            return res.status(201).json(await importService.importFromExcel({
                buffer: req.file.buffer,
                fileName: req.file.originalname,
                title: req.body?.title,
                userId: req.user?.id,
            }));
        } catch (err) { return fail(res, err, 400, 'importExcel'); }
    },

    // ── Cobrança (régua configurável) ──
    async getCobrancaSettings(req, res) {
        try { return res.json(await cobrancaService.getSettings()); }
        catch (err) { return fail(res, err, 400, 'getCobrancaSettings'); }
    },
    async updateCobrancaSettings(req, res) {
        try { return res.json(await cobrancaService.updateSettings({ payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'updateCobrancaSettings'); }
    },
    async listRules(req, res) {
        try { return res.json(await cobrancaService.listRules()); }
        catch (err) { return fail(res, err, 400, 'listRules'); }
    },
    async createRule(req, res) {
        try { return res.status(201).json(await cobrancaService.createRule({ payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'createRule'); }
    },
    async updateRule(req, res) {
        try { return res.json(await cobrancaService.updateRule({ id: req.params.id, payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'updateRule'); }
    },
    async removeRule(req, res) {
        try { return res.json(await cobrancaService.removeRule({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'removeRule'); }
    },
    async runCobranca(req, res) {
        try { return res.json(await cobrancaService.runEngine({ dryRun: req.body?.dryRun === true, force: true })); }
        catch (err) { return fail(res, err, 400, 'runCobranca'); }
    },

    // ── Bulk (edição em cascata) ──
    async bulkTasks(req, res) {
        try { return res.json(await taskService.bulkUpdate({ ids: req.body?.ids, patch: req.body?.patch || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'bulkTasks'); }
    },

    // ── Régua por checklist (padrão/personalizada/desligada) ──
    async getChecklistCobranca(req, res) {
        try { return res.json(await cobrancaService.getChecklistCobranca({ checklistId: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'getChecklistCobranca'); }
    },
    async setChecklistCobranca(req, res) {
        try { return res.json(await cobrancaService.setChecklistCobranca({ checklistId: req.params.id, mode: req.body?.mode, rules: req.body?.rules, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'setChecklistCobranca'); }
    },

    // ── Perfis de autorização (admin) ──
    async listAuthProfiles(req, res) {
        try { return res.json(await authProfileService.listProfiles()); }
        catch (err) { return fail(res, err, 400, 'listAuthProfiles'); }
    },
    async createAuthProfile(req, res) {
        try { return res.status(201).json(await authProfileService.createProfile({ payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'createAuthProfile'); }
    },
    async updateAuthProfile(req, res) {
        try { return res.json(await authProfileService.updateProfile({ id: req.params.id, payload: req.body || {}, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'updateAuthProfile'); }
    },
    async removeAuthProfile(req, res) {
        try { return res.json(await authProfileService.removeProfile({ id: req.params.id })); }
        catch (err) { return fail(res, err, 400, 'removeAuthProfile'); }
    },

    // ── Aprovação (fluxo) ──
    async approvalMe(req, res) {
        try {
            const profiles = await authProfileService.profilesForUser(req.user?.id);
            return res.json({ isApprover: profiles.length > 0, profiles: profiles.map((p) => ({ id: p.id, name: p.name })) });
        } catch (err) { return fail(res, err, 400, 'approvalMe'); }
    },
    async pendingApprovals(req, res) {
        try { return res.json(await taskService.pendingApprovalsFor({ userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'pendingApprovals'); }
    },
    async submitApproval(req, res) {
        try { return res.json(await taskService.submitForApproval({ id: req.params.id, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'submitApproval'); }
    },
    async decideApproval(req, res) {
        try { return res.json(await taskService.decideApproval({ id: req.params.id, profileId: req.body?.profileId, decision: req.body?.decision, comment: req.body?.comment, userId: req.user?.id })); }
        catch (err) { return fail(res, err, 400, 'decideApproval'); }
    },
    async cancelApproval(req, res) {
        try { return res.json(await taskService.cancelApproval({ id: req.params.id, userId: req.user?.id, isAdmin: isAdminReq(req) })); }
        catch (err) { return fail(res, err, 400, 'cancelApproval'); }
    },
    async cancelApproval(req, res) {
        try { return res.json(await taskService.cancelApproval({ id: req.params.id, userId: req.user?.id, isAdmin: isAdminReq(req) })); }
        catch (err) { return fail(res, err, 400, 'cancelApproval'); }
    },
};

export default checklistController;
