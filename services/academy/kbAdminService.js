import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

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

    async update(id, { userId, title, categorySlug, body, payload }) {
        const article = await db.AcademyArticle.findByPk(id);
        if (!article) throw new Error('Artigo não encontrado.');

        const nextCategory = String(categorySlug).trim();
        const nextTitle = String(title).trim();

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
            body: String(body || ''),
            payload: asJsonOrNull(payload), // ✅ novo
            updatedByUserId: userId || article.updatedByUserId || null,
        });

        return article;
    },

    async publish(id, publish, { userId } = {}) {
        const article = await db.AcademyArticle.findByPk(id);
        if (!article) throw new Error('Artigo não encontrado.');

        await article.update({
            status: publish ? 'PUBLISHED' : 'DRAFT',
            updatedByUserId: userId || article.updatedByUserId || null,
        });

        return article;
    },
};

export default kbAdminService;
