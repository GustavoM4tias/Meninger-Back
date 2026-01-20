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
function normalizeStatus(s) {
    const v = String(s || '').toUpperCase();
    return v === 'CLOSED' ? 'CLOSED' : 'OPEN';
}
function cleanTags(tags) {
    return Array.isArray(tags) ? tags.map(String).map(t => t.trim()).filter(Boolean) : [];
}
function safePayload(p) {
    if (!p || typeof p !== 'object') return {};
    return p;
}

function forbid(message = 'Sem permissão.') {
    const e = new Error(message);
    e.statusCode = 403;
    throw e;
}

function canManageTopic({ topic, userId, isAdmin }) {
    if (isAdmin) return true;
    return Number(topic?.createdByUserId) === Number(userId);
}

function pickUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username };
}

/**
 * Categorias fixas por tipo
 * - Mantém no backend para:
 *   1) validar create/update
 *   2) renderizar UI coerente (mesmo se alguém tentar mandar slug inválido)
 */
const COMMUNITY_CATEGORIES = {
    QUESTION: [
        { slug: 'geral', name: 'Geral' },
        { slug: 'comercial', name: 'Comercial' },
        { slug: 'operacao', name: 'Operação' },
        { slug: 'financeiro', name: 'Financeiro' },
        { slug: 'produto', name: 'Produto' },
        { slug: 'ti', name: 'TI' },
    ],
    DISCUSSION: [
        { slug: 'geral', name: 'Geral' },
        { slug: 'processos', name: 'Processos' },
        { slug: 'melhorias', name: 'Melhorias' },
    ],
    SUGGESTION: [
        { slug: 'geral', name: 'Geral' },
        { slug: 'produto', name: 'Produto' },
        { slug: 'processos', name: 'Processos' },
    ],
    INCIDENT: [
        { slug: 'geral', name: 'Geral' },
        { slug: 'sistema', name: 'Sistema' },
        { slug: 'acesso', name: 'Acesso' },
    ],
};

function categoryAllowed(type, categorySlug) {
    const list = COMMUNITY_CATEGORIES[type] || [];
    return list.some(c => c.slug === categorySlug);
}

const communityService = {
    async listTopics({ type, q, status, audience, page, pageSize }) {
        const finalAudience = normalizeAudience(audience);
        const finalType = normalizeType(type);
        const finalStatus = status ? normalizeStatus(status) : undefined;

        const where = {
            ...audienceWhere(finalAudience),
            ...(finalStatus ? { status: finalStatus } : {}),
            ...(finalType ? { type: finalType } : {}),
        };

        if (q && String(q).trim()) {
            const like = `%${String(q).trim()}%`;
            where[Op.or] = [{ title: { [Op.iLike]: like } }];
        }

        const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);

        const { rows, count } = await db.AcademyTopic.findAndCountAll({
            where,
            attributes: [
                'id',
                'title',
                'type',
                'status',
                'audience',
                'categorySlug',
                'tags',
                'acceptedPostId',
                'createdByUserId',
                'updatedByUserId',
                'createdAt',
                'updatedAt',
            ],
            include: db.User ? [
                { model: db.User, as: 'createdBy', attributes: ['id', 'username'], required: false },
                { model: db.User, as: 'updatedBy', attributes: ['id', 'username'], required: false },
            ] : [],
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
        });

        const results = rows.map(r => {
            const o = r.toJSON();
            if (o.createdBy) o.createdBy = pickUser(o.createdBy);
            if (o.updatedBy) o.updatedBy = pickUser(o.updatedBy);
            return o;
        });

        return { page, pageSize, total: count, results };
    },

    async createTopic({ userId, payload }) {
        const title = String(payload?.title || '').trim();
        const type = normalizeType(payload?.type || 'QUESTION') || 'QUESTION';
        const audience = normalizeAudience(payload?.audience || 'BOTH');

        const categorySlug = String(payload?.categorySlug || 'geral').trim() || 'geral';
        if (!categoryAllowed(type, categorySlug)) {
            throw new Error('Categoria inválida para este tipo de tópico.');
        }

        const tags = cleanTags(payload?.tags);
        const body = String(payload?.body || '').trim();
        const postPayload = safePayload(payload?.payload);

        if (!title) throw new Error('Título é obrigatório.');
        if (!body) throw new Error('Conteúdo é obrigatório.');

        const topic = await db.AcademyTopic.create({
            title,
            type,
            status: 'OPEN',
            audience,
            categorySlug,
            tags,
            createdByUserId: userId,
            updatedByUserId: userId,
            acceptedPostId: null,
        });

        const firstPost = await db.AcademyPost.create({
            topicId: topic.id,
            body,
            payload: postPayload,
            createdByUserId: userId,
            updatedByUserId: userId,
            type: 'COMMENT',
        });

        return { topic, firstPost };
    },

    async getTopic({ id, audience }) {
        const finalAudience = normalizeAudience(audience);

        const topic = await db.AcademyTopic.findOne({
            where: { id, ...audienceWhere(finalAudience) },
            attributes: [
                'id',
                'title',
                'type',
                'status',
                'audience',
                'categorySlug',
                'tags',
                'acceptedPostId',
                'createdByUserId',
                'updatedByUserId',
                'acceptedByUserId',
                'acceptedAt',
                'closedByUserId',
                'closedAt',
                'createdAt',
                'updatedAt',
            ],
            include: db.User ? [
                { model: db.User, as: 'createdBy', attributes: ['id', 'username'], required: false },
                { model: db.User, as: 'updatedBy', attributes: ['id', 'username'], required: false },
                { model: db.User, as: 'acceptedBy', attributes: ['id', 'username'], required: false },
                { model: db.User, as: 'closedBy', attributes: ['id', 'username'], required: false },
            ] : [],
        });
        if (!topic) return null;

        const posts = await db.AcademyPost.findAll({
            where: { topicId: id },
            attributes: [
                'id',
                'topicId',
                'body',
                'payload',
                'type',
                'createdByUserId',
                'updatedByUserId',
                'upvotes',
                'createdAt',
                'updatedAt',
            ],
            include: db.User ? [
                { model: db.User, as: 'createdBy', attributes: ['id', 'username'], required: false },
                { model: db.User, as: 'updatedBy', attributes: ['id', 'username'], required: false },
            ] : [],
            order: [['createdAt', 'ASC']],
        });

        const topicJson = topic.toJSON();
        if (topicJson.createdBy) topicJson.createdBy = pickUser(topicJson.createdBy);
        if (topicJson.updatedBy) topicJson.updatedBy = pickUser(topicJson.updatedBy);
        if (topicJson.acceptedBy) topicJson.acceptedBy = pickUser(topicJson.acceptedBy);
        if (topicJson.closedBy) topicJson.closedBy = pickUser(topicJson.closedBy);

        const postsJson = posts.map(p => {
            const o = p.toJSON();
            if (o.createdBy) o.createdBy = pickUser(o.createdBy);
            if (o.updatedBy) o.updatedBy = pickUser(o.updatedBy);
            return o;
        });

        return { topic: topicJson, posts: postsJson };
    },

    async createPost({ userId, topicId, payload }) {
        const body = String(payload?.body || '').trim();
        const postPayload = safePayload(payload?.payload);
        const type = String(payload?.type || 'ANSWER').toUpperCase();

        if (!body) throw new Error('Resposta é obrigatória.');

        const topic = await db.AcademyTopic.findByPk(topicId);
        if (!topic) throw new Error('Tópico não existe.');
        if (topic.status !== 'OPEN') throw new Error('Tópico está fechado.');

        const post = await db.AcademyPost.create({
            topicId,
            body,
            payload: postPayload,
            createdByUserId: userId,
            updatedByUserId: userId,
            type: type === 'COMMENT' ? 'COMMENT' : 'ANSWER',
        });

        await topic.update({ updatedByUserId: userId });

        return post;
    },

    async acceptPost({ userId, isAdmin, topicId, postId }) {
        const topic = await db.AcademyTopic.findByPk(topicId);
        if (!topic) throw new Error('Tópico não existe.');
        if (topic.status !== 'OPEN') throw new Error('Tópico está fechado.');

        if (!canManageTopic({ topic, userId, isAdmin })) {
            forbid('Você só pode marcar solução no seu próprio tópico.');
        }

        const post = await db.AcademyPost.findOne({ where: { id: postId, topicId } });
        if (!post) throw new Error('Resposta não encontrada.');

        await topic.update({
            acceptedPostId: postId,
            acceptedByUserId: userId,
            acceptedAt: new Date(),
            status: 'CLOSED',
            closedByUserId: userId,
            closedAt: new Date(),
            updatedByUserId: userId,
        });

        return { ok: true };
    },

    async closeTopic({ userId, isAdmin, topicId }) {
        const topic = await db.AcademyTopic.findByPk(topicId);
        if (!topic) throw new Error('Tópico não existe.');
        if (topic.status === 'CLOSED') return { ok: true };

        if (!canManageTopic({ topic, userId, isAdmin })) {
            forbid('Você só pode fechar o seu próprio tópico.');
        }

        await topic.update({
            status: 'CLOSED',
            closedByUserId: userId,
            closedAt: new Date(),
            updatedByUserId: userId,
        });

        return { ok: true };
    },

    async reopenTopic({ userId, isAdmin, topicId }) {
        const topic = await db.AcademyTopic.findByPk(topicId);
        if (!topic) throw new Error('Tópico não existe.');
        if (topic.status === 'OPEN') return { ok: true };

        if (!canManageTopic({ topic, userId, isAdmin })) {
            forbid('Você só pode reabrir o seu próprio tópico.');
        }

        await topic.update({
            status: 'OPEN',
            closedByUserId: null,
            closedAt: null,
            updatedByUserId: userId,

            // Se você quiser limpar solução ao reabrir, descomenta:
            // acceptedPostId: null,
            // acceptedByUserId: null,
            // acceptedAt: null,
        });

        return { ok: true };
    },
};

export default communityService;
export { COMMUNITY_CATEGORIES };
