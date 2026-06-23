import comunicadoAdminService from '../../services/academy/comunicadoAdminService.js';
import comunicadoService from '../../services/academy/comunicadoService.js';

const comunicadoController = {
    // ─────────────── Admin ───────────────
    async adminList(req, res) {
        try {
            return res.json(await comunicadoAdminService.list({ status: req.query.status }));
        } catch (err) {
            console.error('[academy.admin.comunicados.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar comunicados.' });
        }
    },

    async adminGet(req, res) {
        try {
            return res.json(await comunicadoAdminService.get({ id: Number(req.params.id) }));
        } catch (err) {
            console.error('[academy.admin.comunicados.get]', err);
            return res.status(404).json({ message: err.message || 'Comunicado não encontrado.' });
        }
    },

    async adminCreate(req, res) {
        try {
            return res.status(201).json(await comunicadoAdminService.create({ payload: req.body || {}, userId: req.user?.id }));
        } catch (err) {
            console.error('[academy.admin.comunicados.create]', err);
            return res.status(400).json({ message: err.message || 'Erro ao criar comunicado.' });
        }
    },

    async adminUpdate(req, res) {
        try {
            return res.json(await comunicadoAdminService.update({ id: Number(req.params.id), payload: req.body || {}, userId: req.user?.id }));
        } catch (err) {
            console.error('[academy.admin.comunicados.update]', err);
            return res.status(400).json({ message: err.message || 'Erro ao atualizar comunicado.' });
        }
    },

    async adminSetAssignments(req, res) {
        try {
            return res.json(await comunicadoAdminService.setAssignments({ id: Number(req.params.id), assignments: req.body?.assignments }));
        } catch (err) {
            console.error('[academy.admin.comunicados.assignments]', err);
            return res.status(400).json({ message: err.message || 'Erro ao definir público-alvo.' });
        }
    },

    async adminPublish(req, res) {
        try {
            return res.json(await comunicadoAdminService.publish({ id: Number(req.params.id), userId: req.user?.id }));
        } catch (err) {
            console.error('[academy.admin.comunicados.publish]', err);
            return res.status(400).json({ message: err.message || 'Erro ao publicar comunicado.' });
        }
    },

    async adminSetStatus(req, res) {
        try {
            return res.json(await comunicadoAdminService.setStatus({ id: Number(req.params.id), status: req.body?.status, userId: req.user?.id }));
        } catch (err) {
            console.error('[academy.admin.comunicados.status]', err);
            return res.status(400).json({ message: err.message || 'Erro ao alterar status.' });
        }
    },

    async adminAdherence(req, res) {
        try {
            return res.json(await comunicadoAdminService.adherence({ id: Number(req.params.id) }));
        } catch (err) {
            console.error('[academy.admin.comunicados.adherence]', err);
            return res.status(404).json({ message: err.message || 'Comunicado não encontrado.' });
        }
    },

    async adminRemove(req, res) {
        try {
            return res.json(await comunicadoAdminService.remove({ id: Number(req.params.id) }));
        } catch (err) {
            console.error('[academy.admin.comunicados.remove]', err);
            return res.status(400).json({ message: err.message || 'Erro ao excluir comunicado.' });
        }
    },

    // ─────────────── Usuário ───────────────
    async myList(req, res) {
        try {
            return res.json(await comunicadoService.listForUser({ userId: req.user?.id }));
        } catch (err) {
            console.error('[academy.comunicados.myList]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar comunicados.' });
        }
    },

    async myPending(req, res) {
        try {
            return res.json(await comunicadoService.pendingCount({ userId: req.user?.id }));
        } catch (err) {
            console.error('[academy.comunicados.myPending]', err);
            return res.status(400).json({ message: err.message || 'Erro ao consultar pendências.' });
        }
    },

    async ack(req, res) {
        try {
            return res.json(await comunicadoService.ack({
                id: Number(req.params.id),
                userId: req.user?.id,
                ip: req.ip,
                userAgent: req.headers['user-agent'],
            }));
        } catch (err) {
            console.error('[academy.comunicados.ack]', err);
            return res.status(400).json({ message: err.message || 'Erro ao confirmar ciência.' });
        }
    },
};

export default comunicadoController;
