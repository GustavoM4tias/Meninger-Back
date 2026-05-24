import ratingsService from '../../services/academy/ratingsService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const ratingsController = {
    async rate(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const { targetType, targetRef, stars, comment = null } = req.body || {};
            const data = await ratingsService.rate({ userId, targetType, targetRef, stars, comment });
            return res.json(data);
        } catch (err) {
            console.error('[academy.ratings.rate]', err);
            return res.status(400).json({ message: err.message || 'Erro ao avaliar.' });
        }
    },

    async removeMine(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const { targetType, targetRef } = req.body || {};
            const data = await ratingsService.removeMine({ userId, targetType, targetRef });
            return res.json(data);
        } catch (err) {
            console.error('[academy.ratings.removeMine]', err);
            return res.status(400).json({ message: err.message || 'Erro ao remover avaliação.' });
        }
    },

    async stats(req, res) {
        try {
            const userId = resolveUserId(req);
            const { targetType, targetRef } = req.query;
            const data = await ratingsService.stats({ targetType, targetRef, userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.ratings.stats]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar estatísticas.' });
        }
    },

    async listReviews(req, res) {
        try {
            const { targetType, targetRef, page = '1', pageSize = '20' } = req.query;
            const data = await ratingsService.listReviews({
                targetType,
                targetRef,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 20,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.ratings.listReviews]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar reviews.' });
        }
    },
};

export default ratingsController;
