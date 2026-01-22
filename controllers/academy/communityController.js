import communityService from '../../services/academy/communityService.js';
import { COMMUNITY_CATEGORIES } from '../../services/academy/communityService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    if (Number.isFinite(headerId) && headerId > 0) return headerId;
    return null;
}

function isAdmin(req) {
    // ajuste conforme seu auth atual:
    // - se já existe req.user.isAdmin use isso
    // - ou role === 'ADMIN'
    if (req.user?.isAdmin === true) return true;

    const role = String(req.user?.role || '').toUpperCase();
    if (role === 'ADMIN') return true;

    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    return roles.map(r => String(r).toUpperCase()).includes('ADMIN');
}

const communityController = {
    async listTopics(req, res) {
        try {
            const {
                type = '',
                q = '',
                status = 'OPEN',
                audience = 'BOTH',
                page = '1',
                pageSize = '20',
            } = req.query;

            const p = Number(page);
            const ps = Number(pageSize);

            const data = await communityService.listTopics({
                type,
                q,
                status,
                audience,
                page: Number.isFinite(p) && p > 0 ? p : 1,
                pageSize: Number.isFinite(ps) && ps > 0 ? ps : 20,
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
            const id = Number(req.params.id);
            const audience = req.query.audience || 'BOTH';

            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ message: 'ID inválido.' });
            }

            const data = await communityService.getTopic({ id, audience });
            if (!data) return res.status(404).json({ message: 'Tópico não encontrado.' });

            return res.json(data);
        } catch (err) {
            console.error('[academy.community.getTopic]', err);
            return res.status(500).json({ message: 'Erro ao carregar tópico.' });
        }
    }, // ✅ vírgula aqui

    async createPost(req, res) {
        try {
            const userId = resolveUserId(req);
            const topicId = Number(req.params.id);

            if (!Number.isFinite(topicId) || topicId <= 0) {
                return res.status(400).json({ message: 'ID inválido.' });
            }

            const data = await communityService.createPost({
                userId,
                topicId,
                payload: req.body,
            });

            return res.status(201).json(data);
        } catch (err) {
            console.error('[academy.community.createPost]', err);
            const status = err.statusCode || 400;
            return res.status(status).json({ message: err.message || 'Erro ao responder.' });
        }
    },

    async acceptPost(req, res) {
        try {
            const userId = resolveUserId(req);
            const topicId = Number(req.params.id);
            const postId = Number(req.params.postId);

            if (!Number.isFinite(topicId) || topicId <= 0 || !Number.isFinite(postId) || postId <= 0) {
                return res.status(400).json({ message: 'ID inválido.' });
            }

            const data = await communityService.acceptPost({
                userId,
                isAdmin: isAdmin(req),
                topicId,
                postId,
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.community.acceptPost]', err);
            const status = err.statusCode || 400;
            return res.status(status).json({ message: err.message || 'Erro ao marcar solução.' });
        }
    },

    async closeTopic(req, res) {
        try {
            const userId = resolveUserId(req);
            const topicId = Number(req.params.id);

            if (!Number.isFinite(topicId) || topicId <= 0) {
                return res.status(400).json({ message: 'ID inválido.' });
            }

            const data = await communityService.closeTopic({
                userId,
                isAdmin: isAdmin(req),
                topicId,
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.community.closeTopic]', err);
            const status = err.statusCode || 400;
            return res.status(status).json({ message: err.message || 'Erro ao fechar tópico.' });
        }
    },

    async listMyTopics(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const { q = '', status = '', audience = 'BOTH', page = '1', pageSize = '20' } = req.query;

            const p = Number(page);
            const ps = Number(pageSize);

            const data = await communityService.listMyTopics({
                userId,
                q,
                status,
                audience,
                page: Number.isFinite(p) && p > 0 ? p : 1,
                pageSize: Number.isFinite(ps) && ps > 0 ? ps : 20,
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.community.listMyTopics]', err);
            return res.status(500).json({ message: 'Erro ao listar meus tópicos.' });
        }
    },

    async reopenTopic(req, res) {
        try {
            const userId = resolveUserId(req);
            const topicId = Number(req.params.id);

            if (!Number.isFinite(topicId) || topicId <= 0) {
                return res.status(400).json({ message: 'ID inválido.' });
            }

            const data = await communityService.reopenTopic({
                userId,
                isAdmin: isAdmin(req),
                topicId,
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.community.reopenTopic]', err);
            const status = err.statusCode || 400;
            return res.status(status).json({ message: err.message || 'Erro ao reabrir tópico.' });
        }
    },

    async getMeta(req, res) {
        return res.json({
            categories: COMMUNITY_CATEGORIES,
            types: [
                { key: 'questions', label: 'Dúvidas', value: 'QUESTION' },
                { key: 'discussions', label: 'Discussões', value: 'DISCUSSION' },
                { key: 'suggestions', label: 'Sugestões', value: 'SUGGESTION' },
                { key: 'incidents', label: 'Incidentes', value: 'INCIDENT' },
            ],
        });
    },
};

export default communityController;
