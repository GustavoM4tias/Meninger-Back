import meService from '../../services/academy/meService.js';
import academyUsersService from '../../services/academy/academyUsersService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    if (Number.isFinite(headerId) && headerId > 0) return headerId;
    return null;
}

const meController = {
    async rank(req, res) {
        try {
            const q = req.query.q || '';
            const page = Number(req.query.page || 1);
            const pageSize = Number(req.query.pageSize || 20);
            const audience = req.query.audience || 'BOTH';

            const data = await academyUsersService.rank({ q, page, pageSize, audience });
            return res.json(data);
        } catch (err) {
            console.error('[academy.users.rank]', err);
            return res.status(500).json({ message: 'Erro ao carregar ranking de usuários.' });
        }
    },
    async getSummary(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Usuário não identificado.' });

            const audience = req.query.audience || 'BOTH';
            const data = await meService.getSummary({ userId, audience });
            return res.json(data);
        } catch (err) {
            console.error('[academy.me.summary]', err);
            return res.status(500).json({ message: 'Erro ao carregar resumo do usuário.' });
        }
    },
    async summary(req, res) {
        try {
            const userId = Number(req.params.id);
            if (!Number.isFinite(userId) || userId <= 0) {
                return res.status(400).json({ message: 'Usuário inválido.' });
            }

            const audience = req.query.audience || 'BOTH';
            const data = await academyUsersService.getUserSummary({ userId, audience });

            // perfil público: sem progresso recente
            data.tracks.list = [];

            return res.json(data);
        } catch (err) {
            console.error('[academy.users.summary]', err);
            return res.status(500).json({ message: 'Erro ao carregar perfil do usuário.' });
        }
    },
};

export default meController;
