import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normalizeAudience(audience) {
    const allowed = new Set(['BOTH', 'GESTOR_ONLY', 'ADM_ONLY']);
    return allowed.has(audience) ? audience : 'BOTH';
}

function audienceWhere(finalAudience) {
    if (finalAudience === 'BOTH') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] } };
    return { audience: { [Op.in]: ['BOTH', finalAudience] } };
}

function normalizeMode(mode) {
    return String(mode || '').toLowerCase() === 'admin' ? 'admin' : '';
}

function normalizeStatus(status) {
    const s = String(status || '').toUpperCase();
    return (s === 'DRAFT' || s === 'PUBLISHED') ? s : '';
}

const kbService = {
    async listCategories({ audience }) {
        const finalAudience = normalizeAudience(audience);

        const rows = await db.AcademyArticle.findAll({
            where: {
                status: 'PUBLISHED',
                ...audienceWhere(finalAudience),
            },
            attributes: ['categorySlug'],
            group: ['category_slug'],
            order: [['categorySlug', 'ASC']],
            raw: true,
        });

        const categories = rows
            .map(r => String(r.categorySlug || '').trim())
            .filter(Boolean)
            .map(slug => ({
                slug,
                name: slug
                    .split('-')
                    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
                    .join(' ')
            }));

        return { categories };
    },

    async listArticles({ q, categorySlug, audience, page, pageSize, mode, status }) {
        const finalAudience = normalizeAudience(audience);
        const finalMode = normalizeMode(mode);
        const finalStatus = normalizeStatus(status);

        const where = { ...audienceWhere(finalAudience) };

        if (finalMode !== 'admin') {
            where.status = 'PUBLISHED';
        } else {
            if (finalStatus) where.status = finalStatus;
        }

        if (categorySlug) where.categorySlug = categorySlug;

        if (q && String(q).trim()) {
            const like = `%${String(q).trim()}%`;
            where[Op.or] = [
                { title: { [Op.iLike]: like } },
                { body: { [Op.iLike]: like } },
            ];
        }

        const safePage = Math.max(1, Number(page) || 1);
        const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const offset = (safePage - 1) * safePageSize;

        const User = db.User || db.Users;

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
                'updatedAt',
                'createdAt',
                // ❗ normalmente não precisa listar payload aqui (list)
                // 'payload',
            ],
            include: [
                { model: User, as: 'createdBy', attributes: ['id', 'username', 'email'], required: false },
                { model: User, as: 'updatedBy', attributes: ['id', 'username', 'email'], required: false },
            ],
            order: [['updatedAt', 'DESC']],
            limit: safePageSize,
            offset,
        });

        return {
            page: safePage,
            pageSize: safePageSize,
            total: count,
            results: rows,
        };
    },

    async getArticle({ categorySlug, articleSlug, audience }) {
        const finalAudience = normalizeAudience(audience);

        const User = db.User || db.Users;

        const row = await db.AcademyArticle.findOne({
            where: {
                status: 'PUBLISHED',
                categorySlug,
                slug: articleSlug,
                ...audienceWhere(finalAudience),
            },
            attributes: [
                'id',
                'title',
                'slug',
                'categorySlug',
                'body',
                'payload',
                'createdByUserId',
                'updatedByUserId',
                'createdAt',
                'updatedAt',
            ],
            include: [
                { model: User, as: 'createdBy', attributes: ['id', 'username', 'email'], required: false },
                { model: User, as: 'updatedBy', attributes: ['id', 'username', 'email'], required: false },
            ],
        });

        return row;
    }

};

export default kbService;
