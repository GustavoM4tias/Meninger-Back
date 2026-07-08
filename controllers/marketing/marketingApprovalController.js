// controllers/marketing/marketingApprovalController.js
// Camada fina sobre o marketingApprovalService (padrão do checklistController).
import svc from '../../services/marketing/marketingApprovalService.js';

function fail(res, err, fallback = 'Erro interno.') {
    const status = err?.httpStatus || 500;
    if (status >= 500) console.error('[marketingApproval]', err);
    return res.status(status).json({ message: err?.message || fallback, code: err?.code || undefined });
}

export default {
    async listCostCenters(req, res) {
        try { res.json(await svc.listCostCenters()); }
        catch (err) { fail(res, err); }
    },

    async me(req, res) {
        try { res.json(await svc.approvalMe(req.user)); }
        catch (err) { fail(res, err); }
    },

    async listTypes(req, res) {
        try { res.json(await svc.listActiveTypes()); }
        catch (err) { fail(res, err); }
    },

    async listProfiles(req, res) {
        try { res.json(await svc.listProfiles()); }
        catch (err) { fail(res, err); }
    },

    async createProfile(req, res) {
        try { res.status(201).json(await svc.createProfile({ payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async updateProfile(req, res) {
        try { res.json(await svc.updateProfile({ id: req.params.id, payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async listUsers(req, res) {
        try { res.json(await svc.listUsers()); }
        catch (err) { fail(res, err); }
    },

    async getSettings(req, res) {
        try { res.json(await svc.getSettings()); }
        catch (err) { fail(res, err); }
    },

    async updateSettings(req, res) {
        try { res.json(await svc.updateSettings({ payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async list(req, res) {
        try { res.json(await svc.list({ user: req.user, filters: req.query })); }
        catch (err) { fail(res, err); }
    },

    async create(req, res) {
        try { res.status(201).json(await svc.createRequest({ payload: req.body, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async getOne(req, res) {
        try { res.json(await svc.getOne({ id: req.params.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async decide(req, res) {
        try { res.json(await svc.decide({ id: req.params.id, payload: req.body, user: req.user, via: 'office' })); }
        catch (err) { fail(res, err); }
    },

    async cancel(req, res) {
        try { res.json(await svc.cancel({ id: req.params.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async downloadPdf(req, res) {
        try {
            const { buffer, protocol } = await svc.generateAuthorizationPdf({ id: req.params.id, user: req.user });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="Autorizacao_${protocol}.pdf"`);
            return res.end(buffer);
        } catch (err) { fail(res, err); }
    },

    async addAttachment(req, res) {
        try { res.status(201).json(await svc.addAttachment({ id: req.params.id, payload: req.body, user: req.user })); }
        catch (err) { fail(res, err); }
    },

    async removeAttachment(req, res) {
        try { res.json(await svc.removeAttachment({ attachmentId: req.params.id, user: req.user })); }
        catch (err) { fail(res, err); }
    },
};
