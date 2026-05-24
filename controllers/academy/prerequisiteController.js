import prerequisiteService from '../../services/academy/prerequisiteService.js';

const prerequisiteController = {
    async list(req, res) {
        try {
            const data = await prerequisiteService.list({ trackSlug: req.params.slug });
            return res.json(data);
        } catch (err) {
            console.error('[academy.prerequisites.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar pré-requisitos.' });
        }
    },

    async add(req, res) {
        try {
            const data = await prerequisiteService.add({
                trackSlug: req.params.slug,
                requiredTrackSlug: req.body?.requiredTrackSlug,
                policy: req.body?.policy,
            });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.prerequisites.add]', err);
            return res.status(400).json({ message: err.message || 'Erro ao adicionar pré-requisito.' });
        }
    },

    async remove(req, res) {
        try {
            const data = await prerequisiteService.remove({ id: req.params.id });
            return res.json(data);
        } catch (err) {
            console.error('[academy.prerequisites.remove]', err);
            return res.status(400).json({ message: err.message || 'Erro ao remover pré-requisito.' });
        }
    },
};

export default prerequisiteController;
