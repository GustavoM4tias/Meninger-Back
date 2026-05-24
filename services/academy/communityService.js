import { Op, fn, col } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { normalizeAudience, audienceWhere } from './audience.js';
import mentionsService from './mentionsService.js';
import gamificationService from './gamificationService.js';

function normalizeMyMode(mode) {
    const v = String(mode || '').toUpperCase();
    return ['CREATED', 'PARTICIPATED', 'BOTH'].includes(v) ? v : 'BOTH';
}

async function topicIdsParticipatedByUser(userId) {
    // pega topicId onde o usuário postou
    const rows = await db.AcademyPost.findAll({
        where: { createdByUserId: userId },
        attributes: [[fn('DISTINCT', col('topicId')), 'topicId']],
        raw: true,
    });

    return rows
        .map(r => Number(r.topicId))
        .filter(n => Number.isFinite(n) && n > 0);
}

async function countsByType(where) {
    const rows = await db.AcademyTopic.findAll({
        where,
        attributes: ['type', [fn('COUNT', col('id')), 'count']],
        group: ['type'],
        raw: true,
    });

    const out = { questions: 0, discussions: 0, suggestions: 0, incidents: 0 };

    // type no banco: QUESTION|DISCUSSION|SUGGESTION|INCIDENT
    for (const r of rows) {
        const t = String(r.type || '').toUpperCase();
        const c = Number(r.count) || 0;
        if (t === 'QUESTION') out.questions = c;
        if (t === 'DISCUSSION') out.discussions = c;
        if (t === 'SUGGESTION') out.suggestions = c;
        if (t === 'INCIDENT') out.incidents = c;
    }

    return out;
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

        // S4.3: Mentions @usuario no body do tópico.
        mentionsService.notifyMentioned({
            body,
            authorUserId: userId,
            context: {
                kind: 'topic',
                refId: Number(topic.id),
                refTitle: title,
                refLink: `/academy/community/topic/${topic.id}`,
                snippet: body.length > 140 ? `${body.slice(0, 140)}…` : body,
            },
        }).catch(err => console.warn('[academy.community.createTopic] mentions failed', err?.message));

        // S5.1: XP por criar tópico
        gamificationService.awardXp({
            userId,
            reason: 'TOPIC_CREATED',
            refKind: 'topic',
            refId: String(topic.id),
        }).catch(err => console.warn('[gamification.topicCreated]', err?.message));

        return { topic, firstPost };
    },

    async getTopic({ id, audience, userId = null }) {
        const finalAudience = normalizeAudience(audience);

        const topicId = Number(id);
        if (!Number.isFinite(topicId) || topicId <= 0) return null;

        const topic = await db.AcademyTopic.findOne({
            where: { id: topicId, ...audienceWhere(finalAudience) },
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

        // upvotes do usuário atual (para flag hasUpvoted)
        let myUpvotedPostIds = new Set();
        if (userId && posts.length) {
            const myVotes = await db.AcademyPostUpvote.findAll({
                where: { userId: Number(userId), postId: { [Op.in]: posts.map(p => p.id) } },
                attributes: ['postId'],
                raw: true,
            });
            myUpvotedPostIds = new Set(myVotes.map(v => Number(v.postId)));
        }

        const postsJson = posts.map(p => {
            const o = p.toJSON();
            if (o.createdBy) o.createdBy = pickUser(o.createdBy);
            if (o.updatedBy) o.updatedBy = pickUser(o.updatedBy);
            o.hasUpvoted = myUpvotedPostIds.has(Number(o.id));
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

        // Notifica o autor do tópico (se não for o próprio que respondeu).
        // Falha silenciosa: notificação não pode quebrar o fluxo de post.
        try {
            const topicAuthorId = Number(topic.createdByUserId);
            if (topicAuthorId && topicAuthorId !== Number(userId)) {
                await NotificationService.notify({
                    type: NotificationType.ACADEMY_TOPIC_REPLIED,
                    recipients: { users: [topicAuthorId] },
                    title: `Nova resposta em "${topic.title}"`,
                    body: body.length > 140 ? `${body.slice(0, 140)}…` : body,
                    data: { topicId: Number(topic.id), postId: Number(post.id) },
                    link: `/academy/community/topic/${topic.id}`,
                    importance: 4,
                });
            }
        } catch (notifyErr) {
            console.warn('[academy.community.createPost] notify failed', notifyErr?.message);
        }

        // S4.3: Mentions @usuario no body do post.
        mentionsService.notifyMentioned({
            body,
            authorUserId: userId,
            context: {
                kind: 'post',
                refId: Number(post.id),
                refTitle: topic.title,
                refLink: `/academy/community/topic/${topic.id}`,
                snippet: body.length > 140 ? `${body.slice(0, 140)}…` : body,
            },
        }).catch(err => console.warn('[academy.community.createPost] mentions failed', err?.message));

        // S5.1: XP por criar post
        gamificationService.awardXp({
            userId,
            reason: 'POST_CREATED',
            refKind: 'post',
            refId: String(post.id),
        }).catch(err => console.warn('[gamification.postCreated]', err?.message));

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

    async getMeta({ audience }) {
        const finalAudience = normalizeAudience(audience);
        const counts = await countsByType({
            ...audienceWhere(finalAudience),
            status: 'OPEN',
        });

        return {
            audience: finalAudience,
            categories: COMMUNITY_CATEGORIES,
            types: [
                { key: 'questions', label: 'Dúvidas', value: 'QUESTION', count: counts.questions },
                { key: 'discussions', label: 'Discussões', value: 'DISCUSSION', count: counts.discussions },
                { key: 'suggestions', label: 'Sugestões', value: 'SUGGESTION', count: counts.suggestions },
                { key: 'incidents', label: 'Incidentes', value: 'INCIDENT', count: counts.incidents },
            ],
        };
    },

    async upvotePost({ userId, postId }) {
        const uid = Number(userId);
        const pid = Number(postId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
        if (!Number.isFinite(pid) || pid <= 0) throw new Error('Post inválido.');

        const post = await db.AcademyPost.findByPk(pid);
        if (!post) throw new Error('Post não encontrado.');

        // upvote do próprio post: rejeita (regra simples).
        if (Number(post.createdByUserId) === uid) {
            const e = new Error('Você não pode votar no próprio post.');
            e.statusCode = 400;
            throw e;
        }

        // tenta criar — se UNIQUE colidir, já tinha votado.
        try {
            await db.AcademyPostUpvote.create({ postId: pid, userId: uid });
        } catch (err) {
            const isDup = err?.name === 'SequelizeUniqueConstraintError';
            if (!isDup) throw err;
            // já votou: idempotente, devolve estado atual.
            return { ok: true, upvoted: true, upvotes: Number(post.upvotes || 0) };
        }

        // recalcula contador agregado a partir da tabela (fonte de verdade).
        const upvotes = await db.AcademyPostUpvote.count({ where: { postId: pid } });
        await post.update({ upvotes });

        // S5.1: XP para o AUTOR do post pelo upvote recebido.
        // refId composto (postId+voterId) garante idempotência por par.
        gamificationService.awardXp({
            userId: Number(post.createdByUserId),
            reason: 'POST_UPVOTED',
            refKind: 'upvote',
            refId: `${pid}:${uid}`,
        }).catch(err => console.warn('[gamification.postUpvoted]', err?.message));

        return { ok: true, upvoted: true, upvotes };
    },

    async clearUpvote({ userId, postId }) {
        const uid = Number(userId);
        const pid = Number(postId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
        if (!Number.isFinite(pid) || pid <= 0) throw new Error('Post inválido.');

        const post = await db.AcademyPost.findByPk(pid);
        if (!post) throw new Error('Post não encontrado.');

        await db.AcademyPostUpvote.destroy({ where: { postId: pid, userId: uid } });

        const upvotes = await db.AcademyPostUpvote.count({ where: { postId: pid } });
        await post.update({ upvotes });

        return { ok: true, upvoted: false, upvotes };
    },

    async listMyTopics({ userId, q, status, audience, page, pageSize }) {
        const finalAudience = normalizeAudience(audience);
        const finalStatus = status ? normalizeStatus(status) : undefined;

        const where = {
            ...audienceWhere(finalAudience),
            createdByUserId: Number(userId),
            ...(finalStatus ? { status: finalStatus } : {}),
        };

        if (q && String(q).trim()) {
            const like = `%${String(q).trim()}%`;
            where[Op.or] = [{ title: { [Op.iLike]: like } }];
        }

        const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);

        const { rows, count } = await db.AcademyTopic.findAndCountAll({
            where,
            attributes: [
                'id', 'title', 'type', 'status', 'audience', 'categorySlug', 'tags', 'acceptedPostId',
                'createdByUserId', 'updatedByUserId', 'createdAt', 'updatedAt',
            ],
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset,
        });

        return { page, pageSize, total: count, results: rows.map(r => r.toJSON()) };
    },

};

export default communityService;
export { COMMUNITY_CATEGORIES };
