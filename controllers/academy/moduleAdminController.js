import moduleAdminService from '../../services/academy/moduleAdminService.js';

const moduleAdminController = {
    async list(req, res) {
        try {
            const data = await moduleAdminService.list({ trackSlug: req.params.slug });
            return res.json(data);
        } catch (err) {
            console.error('[academy.modules.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar módulos.' });
        }
    },

    async create(req, res) {
        try {
            const data = await moduleAdminService.create({
                trackSlug: req.params.slug,
                payload: req.body || {},
            });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.modules.create]', err);
            return res.status(400).json({ message: err.message || 'Erro ao criar módulo.' });
        }
    },

    async update(req, res) {
        try {
            const data = await moduleAdminService.update({
                trackSlug: req.params.slug,
                id: req.params.id,
                payload: req.body || {},
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.modules.update]', err);
            return res.status(400).json({ message: err.message || 'Erro ao atualizar módulo.' });
        }
    },

    async remove(req, res) {
        try {
            const data = await moduleAdminService.remove({
                trackSlug: req.params.slug,
                id: req.params.id,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.modules.remove]', err);
            return res.status(400).json({ message: err.message || 'Erro ao remover módulo.' });
        }
    },

    async reorder(req, res) {
        try {
            const data = await moduleAdminService.reorder({
                trackSlug: req.params.slug,
                order: req.body?.order,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.modules.reorder]', err);
            return res.status(400).json({ message: err.message || 'Erro ao reordenar.' });
        }
    },

    async moveItem(req, res) {
        try {
            const data = await moduleAdminService.moveItem({
                trackSlug: req.params.slug,
                itemId: req.params.itemId,
                moduleId: req.body?.moduleId, // pode ser null para desvincular
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.modules.moveItem]', err);
            return res.status(400).json({ message: err.message || 'Erro ao mover item.' });
        }
    },
};

export default moduleAdminController;
