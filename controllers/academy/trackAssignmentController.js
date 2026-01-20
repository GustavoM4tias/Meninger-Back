import trackAssignmentService from '../../services/academy/trackAssignmentService.js';

const trackAssignmentController = {
    async list(req, res) {
        try {
            const { slug } = req.params;
            return res.json(await trackAssignmentService.list({ trackSlug: slug }));
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar vínculos.' });
        }
    },

    async add(req, res) {
        try {
            const { slug } = req.params;
            return res.status(201).json(await trackAssignmentService.add({ trackSlug: slug, payload: req.body }));
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.add]', err);
            return res.status(400).json({ message: err.message || 'Erro ao vincular trilha.' });
        }
    },

    async remove(req, res) {
        try {
            const { slug, id } = req.params;
            return res.json(await trackAssignmentService.remove({ trackSlug: slug, id: Number(id) }));
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.remove]', err);
            return res.status(400).json({ message: err.message || 'Erro ao remover vínculo.' });
        }
    },

    async bulkAdd(req, res) {
        try {
            const { slug } = req.params;
            const { scopeType, scopeValues, required = true } = req.body || {};

            return res.status(201).json(
                await trackAssignmentService.bulkAdd({
                    trackSlug: slug,
                    scopeType,
                    scopeValues,
                    required,
                })
            );
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.bulkAdd]', err);
            return res.status(400).json({ message: err.message || 'Erro ao vincular em massa.' });
        }
    },
};

export default trackAssignmentController;
