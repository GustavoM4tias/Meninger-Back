import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normalizeAudience(a) {
    return ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'].includes(a) ? a : 'BOTH';
}
function audienceWhere(a) {
    if (a === 'BOTH') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] } };
    return { audience: { [Op.in]: ['BOTH', a] } };
}
function normalizeType(type) {
    const map = {
        questions: 'QUESTION',
        discussions: 'DISCUSSION',
        suggestions: 'SUGGESTION',
        incidents: 'INCIDENT',
    };
    return map[type] || (['QUESTION', 'DISCUSSION', 'SUGGESTION', 'INCIDENT'].includes(type) ? type : '');
}

const communityService = {
    async listTopics({ type, q, status, audience, page, pageSize }) {
        const finalAudience = normalizeAudience(audience);
        const finalType = normalizeType(type);
        const where = {
            ...audienceWhere(finalAudience),
            ...(status ? { status } : {}),
            ...(finalType ? { type: finalType } : {}),
        };

        if (q && String(q).trim()) {
            const like = `%${String(q).trim()}%`;
            where[Op.or] = [{ title: { [Op.iLike]: like } }];
        }

        const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);

        const { rows, count } = await db.AcademyTopic.findAndCountAll({
            where,
            attributes: ['id', 'title', 'type', 'status', 'tags', 'acceptedPostId', 'createdAt'],
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
        });

        return { page, pageSize, total: count, results: rows };
    },

    async createTopic({ userId, payload }) {
        const title = String(payload?.title || '').trim();
        const type = normalizeType(payload?.type || 'QUESTION') || 'QUESTION';
        const audience = normalizeAudience(payload?.audience || 'BOTH');
        const tags = Array.isArray(payload?.tags) ? payload.tags.map(String).map(t => t.trim()).filter(Boolean) : [];
        const body = String(payload?.body || '').trim();

        if (!title) throw new Error('Título é obrigatório.');
        if (!body) throw new Error('Conteúdo é obrigatório.');

        // cria tópico + primeiro post (conteúdo do tópico)
        const topic = await db.AcademyTopic.create({
            title, type, status: 'OPEN', audience, tags,
            createdByUserId: userId,
            acceptedPostId: null,
        });

        const firstPost = await db.AcademyPost.create({
            topicId: topic.id,
            body,
            createdByUserId: userId,
            type: 'COMMENT',
        });

        return { topic, firstPost };
    },

    async getTopic({ id, audience }) {
        const finalAudience = normalizeAudience(audience);

        const topic = await db.AcademyTopic.findOne({
            where: { id, ...audienceWhere(finalAudience) },
            attributes: ['id', 'title', 'type', 'status', 'tags', 'acceptedPostId', 'createdByUserId', 'createdAt', 'updatedAt'],
        });
        if (!topic) return null;

        const posts = await db.AcademyPost.findAll({
            where: { topicId: id },
            attributes: ['id', 'topicId', 'body', 'type', 'createdByUserId', 'upvotes', 'createdAt'],
            order: [['createdAt', 'ASC']],
        });

        return { topic, posts };
    },

    async createPost({ userId, topicId, payload }) {
        const body = String(payload?.body || '').trim();
        const type = String(payload?.type || 'ANSWER').toUpperCase();
        if (!body) throw new Error('Resposta é obrigatória.');

        const topic = await db.AcademyTopic.findByPk(topicId);
        if (!topic) throw new Error('Tópico não existe.');
        if (topic.status !== 'OPEN') throw new Error('Tópico está fechado.');

        const post = await db.AcademyPost.create({
            topicId,
            body,
            createdByUserId: userId,
            type: type === 'COMMENT' ? 'COMMENT' : 'ANSWER',
        });

        return post;
    },

    async acceptPost({ userId, topicId, postId }) {
        const topic = await db.AcademyTopic.findByPk(topicId);
        if (!topic) throw new Error('Tópico não existe.');
        if (topic.status !== 'OPEN') throw new Error('Tópico está fechado.');

        // MVP: permitir aceitar por qualquer membro (gestor/adm). Se quiser restringir: topic.createdByUserId === userId
        const post = await db.AcademyPost.findOne({ where: { id: postId, topicId } });
        if (!post) throw new Error('Resposta não encontrada.');

        await topic.update({ acceptedPostId: postId, status: 'CLOSED' });
        return { ok: true };
    },

    async closeTopic({ userId, topicId }) {
        const topic = await db.AcademyTopic.findByPk(topicId);
        if (!topic) throw new Error('Tópico não existe.');
        await topic.update({ status: 'CLOSED' });
        return { ok: true };
    },
};

export default communityService;
