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

// Rótulos amigáveis (com acento) para categorias/subcategorias conhecidas.
// Slugs fora do mapa caem no humanize. Mesma ideia do TOKEN_LABELS.
const KB_LABELS = {
    // categorias
    'comercial': 'Comercial',
    'construtor-de-vendas': 'Construtor de Vendas',
    // subcategorias Comercial
    'cartorio': 'Cartório',
    'caixa-economica': 'Caixa Econômica',
    'assinatura-e-certificacao': 'Assinatura e Certificação',
    // subcategorias Construtor de Vendas
    'leads': 'Leads',
    'portal-do-cliente': 'Portal do Cliente',
    // Gestor
    'painel-do-gestor': 'Painel do Gestor',
};

const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function humanizeSlug(slug) {
    return String(slug || '')
        .split('-')
        .map((s, i) => (i > 0 && CONNECTORS.has(s)) ? s : s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');
}

function kbLabel(slug) {
    return KB_LABELS[slug] || humanizeSlug(slug);
}

const kbService = {
    async listCategories({ userId }) {
        const tokens = await resolveUserTokens(userId);

        // Agrupa por (categoria, subcategoria) com contagem, num único GROUP BY.
        const rows = await db.AcademyArticle.findAll({
            where: {
                [Op.and]: [
                    { status: 'PUBLISHED' },
                    audiencesWhereLiteral(tokens),
                ],
            },
            attributes: [
                'categorySlug',
                'subcategorySlug',
                [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count'],
            ],
            group: ['category_slug', 'subcategory_slug'],
            raw: true,
        });

        // Monta a árvore categoria → subcategorias.
        const catMap = new Map();
        for (const r of rows) {
            const cat = String(r.categorySlug || '').trim();
            if (!cat) continue;
            if (!catMap.has(cat)) catMap.set(cat, { total: 0, subs: new Map() });
            const entry = catMap.get(cat);
            const n = Number(r.count) || 0;
            entry.total += n;
            const sub = String(r.subcategorySlug || '').trim();
            if (sub) entry.subs.set(sub, (entry.subs.get(sub) || 0) + n);
        }

        const categories = [...catMap.keys()]
            .sort((a, b) => a.localeCompare(b))
            .map(slug => ({
                slug,
                name: kbLabel(slug),
                count: catMap.get(slug).total,
                subcategories: [...catMap.get(slug).subs.entries()]
                    .sort((a, b) => kbLabel(a[0]).localeCompare(kbLabel(b[0])))
                    .map(([s, count]) => ({ slug: s, name: kbLabel(s), count })),
            }));

        return { categories };
    },

    async listArticles({ q, categorySlug, subcategorySlug, userId, page, pageSize, mode, status }) {
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
        if (subcategorySlug) andClauses.push({ subcategorySlug });

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
                'subcategorySlug',
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
