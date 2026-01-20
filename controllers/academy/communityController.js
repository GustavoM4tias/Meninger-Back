import communityService from '../../services/academy/communityService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    if (Number.isFinite(headerId) && headerId > 0) return headerId;
    return null;
}

const communityController = {
    async listTopics(req, res) {
        try {
            const { type = '', q = '', status = 'OPEN', audience = 'BOTH', page = '1', pageSize = '20' } = req.query;
            const data = await communityService.listTopics({
                type, q, status, audience,
                page: Number(page) || 1,
                pageSize: Number(pageSize) || 20,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.community.listTopics]', err);
            return res.status(500).json({ message: 'Erro ao listar tópicos.' });
        }
    },

    async createTopic(req, res) {
        try {
            const userId = resolveUserId(req);
            const data = await communityService.createTopic({ userId, payload: req.body });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.community.createTopic]', err);
            return res.status(400).json({ message: err.message || 'Erro ao criar tópico.' });
        }
    },

    async getTopic(req, res) {
        try {
            const { id } = req.params;
            const audience = req.query.audience || 'BOTH';
            const data = await communityService.getTopic({ id: Number(id), audience });
            if (!data) return res.status(404).json({ message: 'Tópico não encontrado.' });
            return res.json(data);
        } catch (err) {
            console.error('[academy.community.getTopic]', err);
            return res.status(500).json({ message: 'Erro ao carregar tópico.' });
        }
    },

    async createPost(req, res) {
        try {
            const userId = resolveUserId(req);
            const { id } = req.params;
            const data = await communityService.createPost({
                userId,
                topicId: Number(id),
                payload: req.body,
            });
            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.community.createPost]', err);
            return res.status(400).json({ message: err.message || 'Erro ao responder.' });
        }
    },

    async acceptPost(req, res) {
        try {
            const userId = resolveUserId(req);
            const { id, postId } = req.params;
            const data = await communityService.acceptPost({
                userId,
                topicId: Number(id),
                postId: Number(postId),
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.community.acceptPost]', err);
            return res.status(400).json({ message: err.message || 'Erro ao marcar solução.' });
        }
    },

    async closeTopic(req, res) {
        try {
            const userId = resolveUserId(req);
            const { id } = req.params;
            const data = await communityService.closeTopic({ userId, topicId: Number(id) });
            return res.json(data);
        } catch (err) {
            console.error('[academy.community.closeTopic]', err);
            return res.status(400).json({ message: err.message || 'Erro ao fechar tópico.' });
        }
    },
};

export default communityController;
