import mentionsService from '../../services/academy/mentionsService.js';

const mentionsController = {
    // GET /academy/users/lookup?q=jo&limit=8
    async lookup(req, res) {
        try {
            const { q = '', limit = '8' } = req.query;
            const actorUserId = req.user?.id
                ?? (Number(req.headers['x-user-id']) > 0 ? Number(req.headers['x-user-id']) : null);
            const data = await mentionsService.lookup({ q, limit: Number(limit) || 8, actorUserId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.mentions.lookup]', err);
            return res.status(400).json({ message: err.message || 'Erro na busca.' });
        }
    },
};

export default mentionsController;
