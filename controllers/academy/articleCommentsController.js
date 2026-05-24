import articleCommentsService from '../../services/academy/articleCommentsService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

function isAdmin(req) {
    if (req.user?.isAdmin === true) return true;
    const role = String(req.user?.role || '').toUpperCase();
    return role === 'ADMIN';
}

const articleCommentsController = {
    async list(req, res) {
        try {
            const articleId = Number(req.params.articleId);
            const userId = resolveUserId(req); // 🔒 para audience check
            const { page = '1', pageSize = '50' } = req.query;
            const data = await articleCommentsService.list({
                articleId,
                userId,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 50,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.comments.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar comentários.' });
        }
    },

    async create(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const articleId = Number(req.params.articleId);
            const { body, parentId = null } = req.body || {};

            const data = await articleCommentsService.create({
                userId,
                articleId,
                body,
                parentId,
            });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.comments.create]', err);
            const status = err.statusCode || 400;
            return res.status(status).json({ message: err.message || 'Erro ao comentar.' });
        }
    },

    async update(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const commentId = Number(req.params.commentId);
            const { body } = req.body || {};
            const data = await articleCommentsService.update({
                userId,
                isAdmin: isAdmin(req),
                commentId,
                body,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.comments.update]', err);
            const status = err.statusCode || 400;
            return res.status(status).json({ message: err.message || 'Erro ao editar.' });
        }
    },

    async remove(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const commentId = Number(req.params.commentId);
            const data = await articleCommentsService.remove({
                userId,
                isAdmin: isAdmin(req),
                commentId,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.comments.remove]', err);
            const status = err.statusCode || 400;
            return res.status(status).json({ message: err.message || 'Erro ao remover.' });
        }
    },
};

export default articleCommentsController;
