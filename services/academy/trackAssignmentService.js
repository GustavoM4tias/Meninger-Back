import db from '../../models/sequelize/index.js';

function normalizeScopeType(v) {
    const t = String(v || '').toUpperCase().trim();
    const allowed = ['ROLE', 'POSITION', 'DEPARTMENT', 'CITY', 'USER']; // + CITY
    if (!allowed.includes(t)) throw new Error('scopeType inválido.');
    return t;
}

function normValue(v) {
    const s = String(v ?? '').trim();
    if (!s) throw new Error('scopeValue inválido.');
    return s;
}

async function ensureTrackExists(trackSlug) {
    const slug = String(trackSlug || '').trim();
    if (!slug) throw new Error('Slug inválido.');
    const track = await db.AcademyTrack.findOne({ where: { slug }, attributes: ['id', 'slug'] });
    if (!track) throw new Error('Trilha não encontrada.');
    return slug;
}

async function validateScope(scopeType, scopeValue) {
    if (scopeType === 'USER') {
        if (!/^\d+$/.test(scopeValue)) throw new Error('USER precisa ser id numérico.');
        const user = await db.User.findByPk(Number(scopeValue), { attributes: ['id'] });
        if (!user) throw new Error('Usuário não encontrado.');
    }

    if (scopeType === 'DEPARTMENT') {
        if (!/^\d+$/.test(scopeValue)) throw new Error('DEPARTMENT precisa ser id numérico.');
        const dep = await db.Department.findByPk(Number(scopeValue), { attributes: ['id'] });
        if (!dep) throw new Error('Departamento não encontrado.');
    }

    if (scopeType === 'CITY') {
        if (!/^\d+$/.test(scopeValue)) throw new Error('CITY precisa ser id numérico.');
        const c = await db.UserCity.findByPk(Number(scopeValue), { attributes: ['id'] });
        if (!c) throw new Error('Cidade não encontrada.');
    }

    if (scopeType === 'POSITION') {
        const code = String(scopeValue).trim();
        if (!code) throw new Error('POSITION precisa ser um code válido.');
        const pos = await db.Position.findOne({ where: { code }, attributes: ['id', 'code'] });
        if (!pos) throw new Error('Cargo (Position.code) não encontrado.');
    }

    if (scopeType === 'ROLE') {
        const r = String(scopeValue).trim();
        if (!['admin', 'user'].includes(r)) throw new Error('ROLE inválida.');
    }
}

const trackAssignmentService = {
    async list({ trackSlug }) {
        const slug = await ensureTrackExists(trackSlug);

        const rows = await db.AcademyTrackAssignment.findAll({
            where: { trackSlug: slug },
            attributes: ['id', 'trackSlug', 'scopeType', 'scopeValue', 'required', 'createdAt'],
            order: [['createdAt', 'DESC']],
        });

        return { results: rows };
    },

    async add({ trackSlug, payload }) {
        const slug = await ensureTrackExists(trackSlug);

        const scopeType = normalizeScopeType(payload?.scopeType);
        const scopeValue = normValue(payload?.scopeValue);
        const required = payload?.required === false ? false : true;

        await validateScope(scopeType, scopeValue);

        const created = await db.AcademyTrackAssignment.create({
            trackSlug: slug,
            scopeType,
            scopeValue,
            required,
        });

        return { assignment: created };
    },

    async remove({ trackSlug, id }) {
        const slug = await ensureTrackExists(trackSlug);

        const row = await db.AcademyTrackAssignment.findOne({ where: { id, trackSlug: slug } });
        if (!row) throw new Error('Vínculo não encontrado.');

        await row.destroy();
        return { ok: true };
    },

    async bulkAdd({ trackSlug, scopeType, scopeValues, required = true }) {
        const slug = await ensureTrackExists(trackSlug);
        const st = normalizeScopeType(scopeType);

        const values = Array.isArray(scopeValues) ? scopeValues.map(normValue) : [];
        if (!values.length) throw new Error('scopeValues vazio.');

        // valida todos (1 a 1) antes de criar
        for (const v of values) {
            // eslint-disable-next-line no-await-in-loop
            await validateScope(st, v);
        }

        const existing = await db.AcademyTrackAssignment.findAll({
            where: { trackSlug: slug, scopeType: st, scopeValue: values },
            attributes: ['scopeValue'],
            raw: true,
        });
        const existingSet = new Set(existing.map(e => String(e.scopeValue)));

        const toCreate = values
            .filter(v => !existingSet.has(String(v)))
            .map(v => ({
                trackSlug: slug,
                scopeType: st,
                scopeValue: v,
                required: required === false ? false : true,
            }));

        if (toCreate.length) await db.AcademyTrackAssignment.bulkCreate(toCreate);

        return { ok: true, created: toCreate.length, skipped: values.length - toCreate.length };
    },
};

export default trackAssignmentService;
