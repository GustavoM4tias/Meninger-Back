import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normStr(v) {
    return String(v ?? '').trim();
}

function normalizeType(v) {
    const t = String(v || '').toUpperCase().trim();
    const allowed = ['LINK', 'ARTICLE', 'TOPIC', 'TRACK'];
    if (!allowed.includes(t)) throw new Error('type inválido (use LINK | ARTICLE | TOPIC | TRACK).');
    return t;
}

function normalizeAudience(v) {
    const a = String(v || '').toUpperCase().trim();
    return ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'].includes(a) ? a : 'BOTH';
}

function normalizePriority(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 10;
    return Math.max(1, Math.min(999, Math.round(n)));
}

const highlightAdminService = {
    async list({ active, audience, type } = {}) {
        const where = {};
        if (active === true || active === 'true') where.active = true;
        if (active === false || active === 'false') where.active = false;
        if (audience) where.audience = normalizeAudience(audience);
        if (type) where.type = normalizeType(type);

        const rows = await db.AcademyHighlight.findAll({
            where,
            attributes: ['id', 'title', 'type', 'target', 'audience', 'priority', 'active', 'createdAt', 'updatedAt'],
            order: [['priority', 'ASC'], ['updatedAt', 'DESC']],
        });

        return { results: rows.map(r => r.toJSON()) };
    },

    async get({ id }) {
        const row = await db.AcademyHighlight.findByPk(Number(id));
        if (!row) throw new Error('Destaque não encontrado.');
        return { highlight: row.toJSON() };
    },

    async create({ payload }) {
        const title = normStr(payload?.title);
        if (!title) throw new Error('Título é obrigatório.');

        const type = normalizeType(payload?.type);
        const target = normStr(payload?.target);
        if (!target) throw new Error('target é obrigatório (URL para LINK, slug para ARTICLE/TRACK, id para TOPIC).');

        const audience = normalizeAudience(payload?.audience);
        const priority = normalizePriority(payload?.priority ?? 10);
        const active = payload?.active === false ? false : true;

        const created = await db.AcademyHighlight.create({
            title, type, target, audience, priority, active,
        });

        return { highlight: created.toJSON() };
    },

    async update({ id, payload }) {
        const row = await db.AcademyHighlight.findByPk(Number(id));
        if (!row) throw new Error('Destaque não encontrado.');

        if (payload?.title !== undefined) {
            const title = normStr(payload.title);
            if (!title) throw new Error('Título é obrigatório.');
            row.title = title;
        }
        if (payload?.type !== undefined) row.type = normalizeType(payload.type);
        if (payload?.target !== undefined) {
            const target = normStr(payload.target);
            if (!target) throw new Error('target é obrigatório.');
            row.target = target;
        }
        if (payload?.audience !== undefined) row.audience = normalizeAudience(payload.audience);
        if (payload?.priority !== undefined) row.priority = normalizePriority(payload.priority);
        if (payload?.active !== undefined) row.active = !!payload.active;

        await row.save();
        return { highlight: row.toJSON() };
    },

    async setActive({ id, active }) {
        const row = await db.AcademyHighlight.findByPk(Number(id));
        if (!row) throw new Error('Destaque não encontrado.');
        row.active = !!active;
        await row.save();
        return { highlight: row.toJSON() };
    },

    async remove({ id }) {
        const row = await db.AcademyHighlight.findByPk(Number(id));
        if (!row) throw new Error('Destaque não encontrado.');
        await row.destroy();
        return { ok: true };
    },

    // order = [3, 1, 2]: aplica priority 1..N
    async reorder({ order } = {}) {
        const ids = Array.isArray(order)
            ? order.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0)
            : [];
        if (!ids.length) throw new Error('Ordem inválida.');
        if (new Set(ids).size !== ids.length) throw new Error('Ordem contém IDs duplicados.');

        const rows = await db.AcademyHighlight.findAll({
            where: { id: { [Op.in]: ids } },
            attributes: ['id'],
            raw: true,
        });
        if (rows.length !== ids.length) throw new Error('Ordem contém destaques inexistentes.');

        await db.sequelize.transaction(async (t) => {
            for (let i = 0; i < ids.length; i += 1) {
                // eslint-disable-next-line no-await-in-loop
                await db.AcademyHighlight.update(
                    { priority: i + 1 },
                    { where: { id: ids[i] }, transaction: t }
                );
            }
        });

        return { ok: true };
    },
};

export default highlightAdminService;
