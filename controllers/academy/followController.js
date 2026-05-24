import followService from '../../services/academy/followService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const followController = {
    async follow(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const { targetType, targetRef } = req.body || {};
            const data = await followService.follow({ userId, targetType, targetRef });
            return res.json(data);
        } catch (err) {
            console.error('[academy.follow.follow]', err);
            return res.status(400).json({ message: err.message || 'Erro ao seguir.' });
        }
    },

    async unfollow(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const { targetType, targetRef } = req.body || {};
            const data = await followService.unfollow({ userId, targetType, targetRef });
            return res.json(data);
        } catch (err) {
            console.error('[academy.follow.unfollow]', err);
            return res.status(400).json({ message: err.message || 'Erro ao deixar de seguir.' });
        }
    },

    async listMine(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const targetType = req.query.targetType || null;
            const data = await followService.listByUser({ userId, targetType });
            return res.json(data);
        } catch (err) {
            console.error('[academy.follow.listMine]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar follows.' });
        }
    },

    // Conta de seguidores de um alvo (público — quem segue trilha X)
    async followersCount(req, res) {
        try {
            const { targetType, targetRef } = req.query;
            const count = await followService.followersCount({ targetType, targetRef });
            return res.json({ count });
        } catch (err) {
            console.error('[academy.follow.followersCount]', err);
            return res.status(400).json({ message: err.message || 'Erro ao contar seguidores.' });
        }
    },
};

export default followController;
