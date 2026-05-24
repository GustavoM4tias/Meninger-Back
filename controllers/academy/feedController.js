import feedService from '../../services/academy/feedService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const feedController = {
    async getMyFeed(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const { page = '1', pageSize = '20' } = req.query;
            const data = await feedService.buildFeed({
                userId,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 20,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.feed.getMyFeed]', err);
            return res.status(400).json({ message: err.message || 'Erro ao montar feed.' });
        }
    },
};

export default feedController;
