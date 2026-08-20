// controllers/marketing/salesStandController.js
// Camada fina sobre o salesStandService.
import svc from '../../services/marketing/salesStandService.js';

function fail(res, err, fallback = 'Erro interno.') {
    const status = err?.httpStatus || 500;
    if (status >= 500) console.error('[salesStand]', err);
    return res.status(status).json({ message: err?.message || fallback, code: err?.code || undefined });
}

export default {
    async listCostCenters(req, res) {
        try { res.json(await svc.listCostCenters()); }
        catch (err) { fail(res, err); }
    },

    // Stands modelo (categorias)
    async listModels(req, res) {
        try { res.json({ items: await svc.listModels() }); }
        catch (err) { fail(res, err); }
    },

    async createModel(req, res) {
        try { res.status(201).json(await svc.createModel({ payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async updateModel(req, res) {
        try { res.json(await svc.updateModel({ id: req.params.id, payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async deleteModel(req, res) {
        try { res.json(await svc.deleteModel({ id: req.params.id })); }
        catch (err) { fail(res, err); }
    },

    // Stands reais
    async listStands(req, res) {
        try { res.json(await svc.listStands()); }
        catch (err) { fail(res, err); }
    },

    async getStandSpend(req, res) {
        try { res.json(await svc.getStandSpend({ id: req.params.id })); }
        catch (err) { fail(res, err); }
    },

    async createStand(req, res) {
        try { res.status(201).json(await svc.createStand({ payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async updateStand(req, res) {
        try { res.json(await svc.updateStand({ id: req.params.id, payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async deleteStand(req, res) {
        try { res.json(await svc.deleteStand({ id: req.params.id })); }
        catch (err) { fail(res, err); }
    },

    async defineStand(req, res) {
        try { res.json(await svc.defineStand({ id: req.params.id, payload: req.body, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },

    async undefineStand(req, res) {
        try { res.json(await svc.undefineStand({ id: req.params.id, userId: req.user.id })); }
        catch (err) { fail(res, err); }
    },
};
