import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { resolveUserTokens, audiencesWhereLiteral } from './audience.js';

function normalizeMode(mode) {
    return String(mode || '').toLowerCase() === 'admin' ? 'admin' : '';
}

function normalizeStatus(status) {
    const s = String(status || '').toUpperCase();
    return (s === 'DRAFT' || s === 'PUBLISHED') ? s : '';
}

const kbService = {
    async listCategories({ userId }) {
        const tokens = await resolveUserTokens(userId);

        const rows = await db.AcademyArticle.findAll({
            where: {
                [Op.and]: [
                    { status: 'PUBLISHED' },
                    audiencesWhereLiteral(tokens),
                ],
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

    async listArticles({ q, categorySlug, userId, page, pageSize, mode, status }) {
        const tokens = await resolveUserTokens(userId);
        const finalMode = normalizeMode(mode);
        const finalStatus = normalizeStatus(status);

        const andClauses = [audiencesWhereLiteral(tokens)];

        if (finalMode !== 'admin') {
            andClauses.push({ status: 'PUBLISHED' });
        } else if (finalStatus) {
            andClauses.push({ status: finalStatus });
        }

        if (categorySlug) andClauses.push({ categorySlug });

        if (q && String(q).trim()) {
            const like = `%${String(q).trim()}%`;
            andClauses.push({
                [Op.or]: [
                    { title: { [Op.iLike]: like } },
                    { body: { [Op.iLike]: like } },
                ],
            });
        }

        const where = { [Op.and]: andClauses };

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
                'audiences',
                'createdByUserId',
                'updatedByUserId',
                'updatedAt',
                'createdAt',
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

    async getArticle({ categorySlug, articleSlug, userId }) {
        const tokens = await resolveUserTokens(userId);

        const User = db.User || db.Users;

        const row = await db.AcademyArticle.findOne({
            where: {
                [Op.and]: [
                    { status: 'PUBLISHED' },
                    { categorySlug },
                    { slug: articleSlug },
                    audiencesWhereLiteral(tokens),
                ],
            },
            attributes: [
                'id',
                'title',
                'slug',
                'categorySlug',
                'body',
                'payload',
                'audiences',
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
