import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import gamificationService from './gamificationService.js';

// Resolve usuários que devem ser notificados por audience.
// BOTH       → todos os ativos
// GESTOR_ONLY→ gestores (heurística atual: role==='admin' OR position contains 'gestor/gerente/diretor')
// ADM_ONLY   → apenas role==='admin'
async function resolveAudienceUserIds(audience) {
    const a = String(audience || 'BOTH').toUpperCase();
    const where = { status: true };

    if (a === 'ADM_ONLY') {
        where.role = 'admin';
    } else if (a === 'GESTOR_ONLY') {
        where[Op.or] = [
            { role: 'admin' },
            { position: { [Op.iLike]: '%gestor%' } },
            { position: { [Op.iLike]: '%gerente%' } },
            { position: { [Op.iLike]: '%diretor%' } },
        ];
    }
    // BOTH: sem filtro adicional

    const users = await db.User.findAll({ where, attributes: ['id'], raw: true });
    return users.map(u => Number(u.id));
}

// S2.4: cria snapshot da versão ATUAL antes de qualquer mudança no artigo.
async function snapshotVersion(article, { userId, message = null } = {}) {
    if (!article) return null;

    // calcula próximo versionNumber: max + 1
    const last = await db.AcademyArticleVersion.max('versionNumber', { where: { articleId: article.id } });
    const versionNumber = (Number(last) || 0) + 1;

    return db.AcademyArticleVersion.create({
        articleId: article.id,
        versionNumber,
        title: article.title,
        slug: article.slug,
        categorySlug: article.categorySlug,
        body: article.body || '',
        payload: article.payload || null,
        wasPublished: article.status === 'PUBLISHED',
        createdByUserId: userId || article.updatedByUserId || article.createdByUserId || null,
        message: message ? String(message).trim().slice(0, 240) : null,
    });
}

async function notifyArticlePublished(article) {
    try {
        if (!article || article.status !== 'PUBLISHED') return;
        const userIds = await resolveAudienceUserIds(article.audience);
        if (!userIds.length) return;

        await NotificationService.notify({
            type: NotificationType.ACADEMY_ARTICLE_PUBLISHED,
            recipients: { users: userIds },
            title: `Novo artigo: ${article.title}`,
            body: 'Um novo artigo da base de conhecimento está disponível.',
            data: { articleSlug: article.slug, categorySlug: article.categorySlug },
            link: `/academy/kb/${encodeURIComponent(article.categorySlug)}/${encodeURIComponent(article.slug)}`,
            importance: 3,
        });
    } catch (err) {
        console.warn('[academy.kb.notifyArticlePublished] failed', err?.message);
    }
}

function kebab(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function normalizeStatus(status) {
    const s = String(status || '').toUpperCase();
    return (s === 'DRAFT' || s === 'PUBLISHED') ? s : '';
}

function asJsonOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    throw new Error('payload inválido (deve ser objeto).');
}

async function uniqueSlug({ baseSlug, ignoreId = null }) {
    let slug = baseSlug || 'artigo';
    let i = 1;

    while (true) {
        const where = { slug };
        if (ignoreId) where.id = { [db.Sequelize.Op.ne]: ignoreId };

        const exists = await db.AcademyArticle.findOne({ where, attributes: ['id'] });
        if (!exists) return slug;

        i += 1;
        slug = `${baseSlug}-${i}`;
    }
}

const kbAdminService = {
    async listMine({ userId, q, status, page, pageSize }) {
        if (!userId) throw new Error('Usuário não identificado.');

        const finalStatus = normalizeStatus(status);

        const safePage = Math.max(1, Number(page) || 1);
        const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const offset = (safePage - 1) * safePageSize;

        const where = { createdByUserId: userId };

        if (finalStatus) where.status = finalStatus;

        if (q && String(q).trim()) {
            const like = `%${String(q).trim()}%`;
            where[Op.or] = [
                { title: { [Op.iLike]: like } },
                { body: { [Op.iLike]: like } },
            ];
        }

        const { rows, count } = await db.AcademyArticle.findAndCountAll({
            where,
            attributes: [
                'id',
                'title',
                'slug',
                'categorySlug',
                'status',
                'createdByUserId',
                'updatedByUserId',
                'createdAt',
                'updatedAt',
            ],
            order: [['updatedAt', 'DESC']],
            limit: safePageSize,
            offset,
        });

        return { page: safePage, pageSize: safePageSize, total: count, results: rows };
    },

    async getById(id) {
        const article = await db.AcademyArticle.findByPk(id, {
            attributes: [
                'id',
                'title',
                'slug',
                'categorySlug',
                'body',
                'payload', // ✅ novo
                'status',
                'createdByUserId',
                'updatedByUserId',
                'createdAt',
                'updatedAt',
            ],
        });
        return article;
    },

    async create({ userId, title, categorySlug, body, payload }) {
        const baseSlug = kebab(title);
        const slug = await uniqueSlug({ baseSlug });

        const article = await db.AcademyArticle.create({
            title: String(title).trim(),
            categorySlug: String(categorySlug).trim(),
            slug,
            body: String(body || ''),
            payload: asJsonOrNull(payload), // ✅ novo
            status: 'DRAFT',
            createdByUserId: userId || null,
            updatedByUserId: userId || null,
        });

        return article;
    },

    async update(id, { userId, title, categorySlug, body, payload, versionMessage = null }) {
        const article = await db.AcademyArticle.findByPk(id);
        if (!article) throw new Error('Artigo não encontrado.');

        // S2.4: detecta se algo MATERIAL mudou — se sim, snapshot da versão atual
        // ANTES de aplicar o update. Mudanças irrelevantes (re-save sem alteração)
        // não geram versão pra evitar lixo no histórico.
        const nextCategory = String(categorySlug).trim();
        const nextTitle = String(title).trim();
        const nextBody = String(body || '');
        const nextPayload = asJsonOrNull(payload);

        const changed =
            nextCategory !== article.categorySlug ||
            nextTitle !== article.title ||
            nextBody !== (article.body || '') ||
            JSON.stringify(nextPayload) !== JSON.stringify(article.payload || null);

        if (changed) {
            await snapshotVersion(article, { userId, message: versionMessage });
        }

        let nextSlug = article.slug;
        const changedKey =
            nextCategory !== article.categorySlug ||
            nextTitle !== article.title;

        if (changedKey) {
            const baseSlug = kebab(nextTitle);
            nextSlug = await uniqueSlug({ baseSlug, ignoreId: article.id });
        }

        await article.update({
            title: nextTitle,
            categorySlug: nextCategory,
            slug: nextSlug,
            body: nextBody,
            payload: nextPayload,
            updatedByUserId: userId || article.updatedByUserId || null,
        });

        return article;
    },

    // S2.4: lista versões do artigo (sem o body completo — pra economizar payload).
    async listVersions(id) {
        const rows = await db.AcademyArticleVersion.findAll({
            where: { articleId: Number(id) },
            attributes: ['id', 'versionNumber', 'title', 'categorySlug', 'wasPublished', 'message', 'createdByUserId', 'createdAt'],
            order: [['versionNumber', 'DESC']],
            include: [
                { model: db.User, as: 'createdBy', attributes: ['id', 'username', 'email'], required: false },
            ],
        });
        return { results: rows };
    },

    async getVersion(id, versionNumber) {
        const v = await db.AcademyArticleVersion.findOne({
            where: { articleId: Number(id), versionNumber: Number(versionNumber) },
        });
        if (!v) throw new Error('Versão não encontrada.');
        return { version: v.toJSON() };
    },

    // Restaura uma versão antiga → snapshot do estado atual + aplica conteúdo da versão.
    async restoreVersion(id, versionNumber, { userId } = {}) {
        const article = await db.AcademyArticle.findByPk(Number(id));
        if (!article) throw new Error('Artigo não encontrado.');

        const v = await db.AcademyArticleVersion.findOne({
            where: { articleId: article.id, versionNumber: Number(versionNumber) },
        });
        if (!v) throw new Error('Versão não encontrada.');

        // snapshot do estado atual antes de sobrescrever
        await snapshotVersion(article, {
            userId,
            message: `Auto-snapshot antes de restaurar versão ${v.versionNumber}`,
        });

        await article.update({
            title: v.title,
            categorySlug: v.categorySlug,
            slug: v.slug, // mantém slug histórico — outra versão pode ter mesmo título mas slug diferente
            body: v.body,
            payload: v.payload,
            updatedByUserId: userId || article.updatedByUserId || null,
        });

        return article;
    },

    async publish(id, publish, { userId } = {}) {
        const article = await db.AcademyArticle.findByPk(id);
        if (!article) throw new Error('Artigo não encontrado.');

        const wasPublished = article.status === 'PUBLISHED';

        await article.update({
            status: publish ? 'PUBLISHED' : 'DRAFT',
            updatedByUserId: userId || article.updatedByUserId || null,
        });

        // Notifica apenas na transição DRAFT→PUBLISHED (não em re-publish nem em despublish).
        if (publish && !wasPublished) {
            notifyArticlePublished(article)
                .catch(err => console.warn('[academy.kb.publish] notify failed', err?.message));

            // S5.1: XP por publicar artigo (1ª vez — idempotente por articleId)
            const authorId = Number(article.createdByUserId);
            if (authorId) {
                gamificationService.awardXp({
                    userId: authorId,
                    reason: 'ARTICLE_PUBLISHED',
                    refKind: 'article',
                    refId: String(article.id),
                }).catch(err => console.warn('[gamification.articlePublished]', err?.message));
            }
        }

        return article;
    },
};

export default kbAdminService;
