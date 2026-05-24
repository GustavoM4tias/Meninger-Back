import gamificationService from '../../services/academy/gamificationService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const gamificationController = {
    async myStats(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });
            const data = await gamificationService.getStats({ userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.gamification.myStats]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar stats.' });
        }
    },

    async userStats(req, res) {
        try {
            const userId = Number(req.params.userId);
            if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ message: 'ID inválido.' });
            const data = await gamificationService.getStats({ userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.gamification.userStats]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar stats.' });
        }
    },

    async myBadges(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });
            const data = await gamificationService.listUserBadges({ userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.gamification.myBadges]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar badges.' });
        }
    },

    async userBadges(req, res) {
        try {
            const userId = Number(req.params.userId);
            if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ message: 'ID inválido.' });
            const data = await gamificationService.listUserBadges({ userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.gamification.userBadges]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar badges.' });
        }
    },
};

export default gamificationController;
