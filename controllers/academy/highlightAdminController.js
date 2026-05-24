import highlightAdminService from '../../services/academy/highlightAdminService.js';

const highlightAdminController = {
    async list(req, res) {
        try {
            const { active, audience, type } = req.query;
            const data = await highlightAdminService.list({ active, audience, type });
            return res.json(data);
        } catch (err) {
            console.error('[academy.admin.highlights.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar destaques.' });
        }
    },

    async get(req, res) {
        try {
            const data = await highlightAdminService.get({ id: Number(req.params.id) });
            return res.json(data);
        } catch (err) {
            console.error('[academy.admin.highlights.get]', err);
            return res.status(404).json({ message: err.message || 'Destaque não encontrado.' });
        }
    },

    async create(req, res) {
        try {
            const data = await highlightAdminService.create({ payload: req.body || {} });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.admin.highlights.create]', err);
            return res.status(400).json({ message: err.message || 'Erro ao criar destaque.' });
        }
    },

    async update(req, res) {
        try {
            const data = await highlightAdminService.update({
                id: Number(req.params.id),
                payload: req.body || {},
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.admin.highlights.update]', err);
            return res.status(400).json({ message: err.message || 'Erro ao atualizar destaque.' });
        }
    },

    async setActive(req, res) {
        try {
            const data = await highlightAdminService.setActive({
                id: Number(req.params.id),
                active: !!req.body?.active,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.admin.highlights.setActive]', err);
            return res.status(400).json({ message: err.message || 'Erro ao alterar status.' });
        }
    },

    async remove(req, res) {
        try {
            const data = await highlightAdminService.remove({ id: Number(req.params.id) });
            return res.json(data);
        } catch (err) {
            console.error('[academy.admin.highlights.remove]', err);
            return res.status(400).json({ message: err.message || 'Erro ao excluir destaque.' });
        }
    },

    async reorder(req, res) {
        try {
            const data = await highlightAdminService.reorder({ order: req.body?.order });
            return res.json(data);
        } catch (err) {
            console.error('[academy.admin.highlights.reorder]', err);
            return res.status(400).json({ message: err.message || 'Erro ao reordenar.' });
        }
    },
};

export default highlightAdminController;
