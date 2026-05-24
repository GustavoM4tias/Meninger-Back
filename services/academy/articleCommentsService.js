// services/academy/articleCommentsService.js
//
// CRUD de comentários em artigos da KB. Threading 1 nível (comentário raiz +
// replies diretas). Soft delete preserva threads.
//
// Notify:
//   - autor do artigo recebe ACADEMY_ARTICLE_COMMENTED
//   - autor do comentário-pai recebe ACADEMY_COMMENT_REPLIED em replies
//   - usuários mencionados (@username) recebem ACADEMY_MENTIONED

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import mentionsService from './mentionsService.js';
import gamificationService from './gamificationService.js';
import { resolveAudienceForUser, audienceWhere } from './audience.js';

function pickUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username };
}

function ensureBody(body) {
    const s = String(body || '').trim();
    if (!s) throw new Error('Comentário não pode ser vazio.');
    if (s.length > 4000) throw new Error('Comentário muito longo (máx 4000 caracteres).');
    return s;
}

async function findArticleOr404(articleId, { userId = null } = {}) {
    // 🔒 Audience check: user só vê/comenta artigos da sua audience.
    const audience = await resolveAudienceForUser(userId);
    const article = await db.AcademyArticle.findOne({
        where: {
            id: Number(articleId),
            ...audienceWhere(audience),
        },
        attributes: ['id', 'slug', 'title', 'categorySlug', 'createdByUserId', 'status', 'audience'],
        raw: true,
    });
    if (!article) throw new Error('Artigo não encontrado.');
    return article;
}

const articleCommentsService = {
    /**
     * Lista comentários do artigo (raiz + replies). Tree montada no service.
     * Comentários DELETED aparecem mas com body sanitizado.
     */
    async list({ articleId, userId = null, page = 1, pageSize = 50 }) {
        const aid = Number(articleId);
        if (!Number.isFinite(aid) || aid <= 0) throw new Error('Artigo inválido.');

        // 🔒 Audience check antes de listar comentários (evita vazamento via id).
        await findArticleOr404(aid, { userId });

        const safePage = Math.max(1, Number(page) || 1);
        const safePageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));

        const rows = await db.AcademyArticleComment.findAll({
            where: { articleId: aid },
            attributes: ['id', 'parentId', 'userId', 'body', 'status', 'editedAt', 'createdAt'],
            include: db.User ? [
                { model: db.User, as: 'user', attributes: ['id', 'username'], required: false },
            ] : [],
            order: [['createdAt', 'ASC']],
        });

        // Monta tree de 1 nível
        const roots = [];
        const repliesByParent = new Map();

        for (const r of rows) {
            const json = r.toJSON();
            if (json.user) json.user = pickUser(json.user);
            // Sanitiza body de comentário DELETED.
            if (json.status === 'DELETED') json.body = '[comentário removido]';

            if (json.parentId == null) {
                roots.push({ ...json, replies: [] });
            } else {
                if (!repliesByParent.has(Number(json.parentId))) {
                    repliesByParent.set(Number(json.parentId), []);
                }
                repliesByParent.get(Number(json.parentId)).push(json);
            }
        }

        for (const root of roots) {
            root.replies = repliesByParent.get(Number(root.id)) || [];
        }

        const total = rows.length;
        // Paginação aplica APENAS aos roots.
        const offset = (safePage - 1) * safePageSize;
        const pagedRoots = roots.slice(offset, offset + safePageSize);

        return {
            page: safePage,
            pageSize: safePageSize,
            total: roots.length, // total de comentários raiz
            totalIncludingReplies: total,
            results: pagedRoots,
        };
    },

    async create({ userId, articleId, body, parentId = null }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
        // 🔒 audience validation
        const article = await findArticleOr404(articleId, { userId: uid });
        if (article.status !== 'PUBLISHED') {
            // Apenas autores e admin podem comentar em DRAFT — heurística:
            // ignoramos por agora, exigindo PUBLISHED.
            throw new Error('Artigo não está publicado.');
        }
        const text = ensureBody(body);

        // Threading 1 nível: se parentId fornecido, valida que existe E que é raiz.
        let parent = null;
        if (parentId != null) {
            parent = await db.AcademyArticleComment.findOne({
                where: { id: Number(parentId), articleId: article.id },
            });
            if (!parent) throw new Error('Comentário pai não encontrado.');
            if (parent.parentId != null) {
                throw new Error('Não é possível responder a uma resposta — responda ao comentário raiz.');
            }
        }

        const created = await db.AcademyArticleComment.create({
            articleId: article.id,
            parentId: parent ? parent.id : null,
            userId: uid,
            body: text,
            status: 'ACTIVE',
        });

        // ─── Notifications ────────────────────────────────────────────────
        // 1) autor do artigo (se não for o próprio comentador)
        if (article.createdByUserId && Number(article.createdByUserId) !== uid) {
            NotificationService.notify({
                type: NotificationType.ACADEMY_ARTICLE_COMMENTED,
                recipients: { users: [Number(article.createdByUserId)] },
                title: `Comentário em "${article.title}"`,
                body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
                data: { articleId: article.id, commentId: created.id, categorySlug: article.categorySlug, slug: article.slug },
                link: `/academy/kb/${encodeURIComponent(article.categorySlug)}/${encodeURIComponent(article.slug)}#c-${created.id}`,
                importance: 4,
            }).catch(err => console.warn('[academy.comments.notify article author]', err?.message));
        }

        // 2) autor do comentário-pai (em reply)
        if (parent && Number(parent.userId) !== uid && Number(parent.userId) !== Number(article.createdByUserId)) {
            NotificationService.notify({
                type: NotificationType.ACADEMY_COMMENT_REPLIED,
                recipients: { users: [Number(parent.userId)] },
                title: `Resposta no seu comentário em "${article.title}"`,
                body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
                data: { articleId: article.id, commentId: created.id, parentId: parent.id },
                link: `/academy/kb/${encodeURIComponent(article.categorySlug)}/${encodeURIComponent(article.slug)}#c-${created.id}`,
                importance: 5,
            }).catch(err => console.warn('[academy.comments.notify parent author]', err?.message));
        }

        // 3) Mentions @usuario no body
        mentionsService.notifyMentioned({
            body: text,
            authorUserId: uid,
            context: {
                kind: 'article-comment',
                refId: created.id,
                refTitle: article.title,
                refLink: `/academy/kb/${encodeURIComponent(article.categorySlug)}/${encodeURIComponent(article.slug)}#c-${created.id}`,
                snippet: text.length > 140 ? `${text.slice(0, 140)}…` : text,
            },
        }).catch(err => console.warn('[academy.comments.mentions]', err?.message));

        // S5.1: XP por comentar
        gamificationService.awardXp({
            userId: uid,
            reason: 'COMMENT_POSTED',
            refKind: 'comment',
            refId: String(created.id),
        }).catch(err => console.warn('[gamification.commentPosted]', err?.message));

        return { comment: created.toJSON() };
    },

    async update({ userId, isAdmin, commentId, body }) {
        const uid = Number(userId);
        const cid = Number(commentId);
        const c = await db.AcademyArticleComment.findByPk(cid);
        if (!c) throw new Error('Comentário não encontrado.');
        if (c.status === 'DELETED') throw new Error('Comentário foi removido.');

        // Só o autor ou admin pode editar.
        if (Number(c.userId) !== uid && !isAdmin) {
            const err = new Error('Você só pode editar seus próprios comentários.');
            err.statusCode = 403;
            throw err;
        }

        const text = ensureBody(body);
        c.body = text;
        c.editedAt = new Date();
        await c.save();
        return { comment: c.toJSON() };
    },

    async remove({ userId, isAdmin, commentId }) {
        const uid = Number(userId);
        const cid = Number(commentId);
        const c = await db.AcademyArticleComment.findByPk(cid);
        if (!c) throw new Error('Comentário não encontrado.');
        if (c.status === 'DELETED') return { ok: true, alreadyRemoved: true };

        // Só o autor ou admin pode remover.
        if (Number(c.userId) !== uid && !isAdmin) {
            const err = new Error('Você só pode remover seus próprios comentários.');
            err.statusCode = 403;
            throw err;
        }

        c.status = 'DELETED';
        c.body = ''; // sanitiza
        await c.save();
        return { ok: true };
    },

    // Total de comentários ACTIVE em um artigo (usado por kbService.getArticle).
    async countForArticle(articleId) {
        return db.AcademyArticleComment.count({
            where: { articleId: Number(articleId), status: 'ACTIVE' },
        });
    },
};

export default articleCommentsService;
