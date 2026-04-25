// controllers/microsoft/MicrosoftPlannerController.js
import db from '../../models/sequelize/index.js';
import plannerService from '../../services/microsoft/MicrosoftPlannerService.js';

class MicrosoftPlannerController {

    async _getUser(userId) {
        return db.User.findByPk(userId, {
            attributes: ['id', 'microsoft_id', 'microsoft_access_token', 'microsoft_refresh_token', 'microsoft_token_expires_at'],
        });
    }

    _notConnected(res) {
        return res.status(401).json({ error: 'Conta Microsoft não conectada. Vincule sua conta em Minha Conta.' });
    }

    _err(res, err, ctx) {
        console.error(`❌ [Planner] ${ctx}:`, err?.response?.data || err.message);
        return res.status(err?.response?.status || 500).json({ error: err.message });
    }

    // ── GET /api/microsoft/planner/groups ────────────────────────────────────
    getGroups = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await plannerService.getMyGroups(user));
        } catch (err) { return this._err(res, err, 'getGroups'); }
    };

    // ── GET /api/microsoft/planner/groups/:groupId/plans ────────────────────
    getGroupPlans = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await plannerService.getGroupPlans(user, req.params.groupId));
        } catch (err) { return this._err(res, err, 'getGroupPlans'); }
    };

    // ── GET /api/microsoft/planner/plans/:planId/full ────────────────────────
    // Retorna buckets + tasks do plano em uma só chamada
    getPlanFull = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await plannerService.getPlanFull(user, req.params.planId));
        } catch (err) { return this._err(res, err, 'getPlanFull'); }
    };

    // ── POST /api/microsoft/planner/plans ────────────────────────────────────
    createPlan = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { groupId, title } = req.body;
            if (!groupId || !title) return res.status(400).json({ error: 'groupId e title são obrigatórios.' });
            return res.status(201).json(await plannerService.createPlan(user, groupId, title));
        } catch (err) { return this._err(res, err, 'createPlan'); }
    };

    // ── PATCH /api/microsoft/planner/plans/:planId ───────────────────────────
    updatePlan = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { etag, ...data } = req.body;
            if (!etag) return res.status(400).json({ error: 'etag é obrigatório para atualização.' });
            return res.json(await plannerService.updatePlan(user, req.params.planId, data, etag));
        } catch (err) { return this._err(res, err, 'updatePlan'); }
    };

    // ── DELETE /api/microsoft/planner/plans/:planId ──────────────────────────
    deletePlan = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { etag } = req.body;
            if (!etag) return res.status(400).json({ error: 'etag é obrigatório.' });
            await plannerService.deletePlan(user, req.params.planId, etag);
            return res.status(204).send();
        } catch (err) { return this._err(res, err, 'deletePlan'); }
    };

    // ── POST /api/microsoft/planner/buckets ──────────────────────────────────
    createBucket = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { planId, name, orderHint } = req.body;
            if (!planId || !name) return res.status(400).json({ error: 'planId e name são obrigatórios.' });
            return res.status(201).json(await plannerService.createBucket(user, planId, name, orderHint));
        } catch (err) { return this._err(res, err, 'createBucket'); }
    };

    // ── PATCH /api/microsoft/planner/buckets/:bucketId ───────────────────────
    updateBucket = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { etag, ...data } = req.body;
            if (!etag) return res.status(400).json({ error: 'etag é obrigatório.' });
            return res.json(await plannerService.updateBucket(user, req.params.bucketId, data, etag));
        } catch (err) { return this._err(res, err, 'updateBucket'); }
    };

    // ── DELETE /api/microsoft/planner/buckets/:bucketId ──────────────────────
    deleteBucket = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { etag } = req.body;
            if (!etag) return res.status(400).json({ error: 'etag é obrigatório.' });
            await plannerService.deleteBucket(user, req.params.bucketId, etag);
            return res.status(204).send();
        } catch (err) { return this._err(res, err, 'deleteBucket'); }
    };

    // ── POST /api/microsoft/planner/tasks ────────────────────────────────────
    createTask = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { planId, bucketId, title } = req.body;
            if (!planId || !bucketId || !title) return res.status(400).json({ error: 'planId, bucketId e title são obrigatórios.' });
            return res.status(201).json(await plannerService.createTask(user, req.body));
        } catch (err) { return this._err(res, err, 'createTask'); }
    };

    // ── PATCH /api/microsoft/planner/tasks/:taskId ───────────────────────────
    updateTask = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { etag, ...data } = req.body;
            if (!etag) return res.status(400).json({ error: 'etag é obrigatório.' });
            return res.json(await plannerService.updateTask(user, req.params.taskId, data, etag));
        } catch (err) { return this._err(res, err, 'updateTask'); }
    };

    // ── DELETE /api/microsoft/planner/tasks/:taskId ──────────────────────────
    deleteTask = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { etag } = req.body;
            if (!etag) return res.status(400).json({ error: 'etag é obrigatório.' });
            await plannerService.deleteTask(user, req.params.taskId, etag);
            return res.status(204).send();
        } catch (err) { return this._err(res, err, 'deleteTask'); }
    };

    // ── GET /api/microsoft/planner/tasks/:taskId/details ─────────────────────
    getTaskDetails = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            return res.json(await plannerService.getTaskDetails(user, req.params.taskId));
        } catch (err) { return this._err(res, err, 'getTaskDetails'); }
    };

    // ── PATCH /api/microsoft/planner/tasks/:taskId/details ───────────────────
    updateTaskDetails = async (req, res) => {
        try {
            const user = await this._getUser(req.user.id);
            if (!user?.microsoft_id) return this._notConnected(res);
            const { etag, ...data } = req.body;
            if (!etag) return res.status(400).json({ error: 'etag é obrigatório.' });
            return res.json(await plannerService.updateTaskDetails(user, req.params.taskId, data, etag));
        } catch (err) { return this._err(res, err, 'updateTaskDetails'); }
    };
}

export default new MicrosoftPlannerController();
