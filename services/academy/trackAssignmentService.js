import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

// Resolve userIds afetados por um assignment (ROLE/POSITION/DEPARTMENT/CITY/USER).
async function resolveAffectedUserIds({ scopeType, scopeValue }) {
    if (scopeType === 'USER') {
        const uid = Number(scopeValue);
        return Number.isFinite(uid) && uid > 0 ? [uid] : [];
    }

    const where = { status: true };

    if (scopeType === 'ROLE') {
        where.role = String(scopeValue).trim();
    } else if (scopeType === 'POSITION') {
        const pos = await db.Position.findOne({
            where: { code: String(scopeValue).trim() },
            attributes: ['name'],
            raw: true,
        });
        if (!pos?.name) return [];
        where.position = pos.name;
    } else if (scopeType === 'DEPARTMENT') {
        const positions = await db.Position.findAll({
            where: { department_id: Number(scopeValue) },
            attributes: ['name'],
            raw: true,
        });
        const names = positions.map(p => p.name).filter(Boolean);
        if (!names.length) return [];
        where.position = { [Op.in]: names };
    } else if (scopeType === 'CITY') {
        const city = await db.UserCity.findByPk(Number(scopeValue), { attributes: ['name'], raw: true });
        if (!city?.name) return [];
        where.city = city.name;
    } else {
        return [];
    }

    const users = await db.User.findAll({ where, attributes: ['id'], raw: true });
    return users.map(u => Number(u.id));
}

async function notifyAssigned({ trackSlug, scopeType, scopeValue, mandatory = false, dueAt = null }) {
    try {
        const track = await db.AcademyTrack.findOne({
            where: { slug: trackSlug },
            attributes: ['title', 'slug', 'status'],
            raw: true,
        });
        if (!track || track.status !== 'PUBLISHED') return;

        const userIds = await resolveAffectedUserIds({ scopeType, scopeValue });
        if (!userIds.length) return;

        const isObrigatoria = !!mandatory;
        const prazoStr = dueAt
            ? new Date(dueAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
            : null;

        const title = isObrigatoria
            ? `Trilha obrigatória atribuída: ${track.title}`
            : `Nova trilha disponível: ${track.title}`;

        const body = isObrigatoria && prazoStr
            ? `Você precisa concluir esta trilha até ${prazoStr}.`
            : (isObrigatoria
                ? 'Você precisa concluir esta trilha (sem prazo definido).'
                : 'Você tem uma nova trilha de aprendizagem para iniciar.');

        await NotificationService.notify({
            type: NotificationType.ACADEMY_TRACK_ASSIGNED,
            recipients: { users: userIds },
            title,
            body,
            data: { trackSlug: track.slug, mandatory: isObrigatoria, dueAt: dueAt || null },
            link: `/academy/tracks/${encodeURIComponent(track.slug)}`,
            importance: isObrigatoria ? 7 : 5,
        });
    } catch (err) {
        console.warn('[academy.trackAssignment.notify] failed', err?.message);
    }
}

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

function normalizeDueAt(v) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error('dueAt inválido.');
    return d;
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
        const mandatory = payload?.mandatory === true;
        const dueAt = normalizeDueAt(payload?.dueAt);

        await validateScope(scopeType, scopeValue);

        const created = await db.AcademyTrackAssignment.create({
            trackSlug: slug,
            scopeType,
            scopeValue,
            required,
            mandatory,
            dueAt,
        });

        // dispara em background — não bloqueia o response; protege contra unhandled rejection.
        notifyAssigned({ trackSlug: slug, scopeType, scopeValue, mandatory, dueAt })
            .catch(err => console.warn('[academy.trackAssignment.add] notify failed', err?.message));

        return { assignment: created };
    },

    async remove({ trackSlug, id }) {
        const slug = await ensureTrackExists(trackSlug);

        const row = await db.AcademyTrackAssignment.findOne({ where: { id, trackSlug: slug } });
        if (!row) throw new Error('Vínculo não encontrado.');

        await row.destroy();
        return { ok: true };
    },

    // Dashboard de aderência: para uma trilha, devolve o status de cada user afetado.
    // Status: COMPLETED | IN_PROGRESS | NOT_STARTED | OVERDUE.
    async adherence({ trackSlug }) {
        const slug = await ensureTrackExists(trackSlug);

        // 1) coleta assignments com mandate/due
        const assigns = await db.AcademyTrackAssignment.findAll({
            where: { trackSlug: slug },
            attributes: ['scopeType', 'scopeValue', 'required', 'mandatory', 'dueAt'],
            raw: true,
        });

        // 2) Resolve userIds afetados — só usuários sob assignments mandatórios contam para a aderência.
        const mandatoryAssigns = assigns.filter(a => a.mandatory);
        if (!mandatoryAssigns.length) {
            return { trackSlug: slug, total: 0, completed: 0, inProgress: 0, notStarted: 0, overdue: 0, users: [] };
        }

        // Agrega userIds + dueAt mais próximo por user (se há múltiplos assignments)
        const userIdToDue = new Map();
        for (const a of mandatoryAssigns) {
            // eslint-disable-next-line no-await-in-loop
            const ids = await resolveAffectedUserIds({ scopeType: a.scopeType, scopeValue: a.scopeValue });
            for (const uid of ids) {
                const existing = userIdToDue.get(uid);
                const due = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
                if (!existing || due < existing) userIdToDue.set(uid, due);
            }
        }

        const userIds = Array.from(userIdToDue.keys());
        if (!userIds.length) {
            return { trackSlug: slug, total: 0, completed: 0, inProgress: 0, notStarted: 0, overdue: 0, users: [] };
        }

        // 3) progresso atual
        const progress = await db.AcademyUserTrackProgress.findAll({
            where: { userId: userIds, trackSlug: slug },
            attributes: ['userId', 'status', 'progressPercent'],
            raw: true,
        });
        const progressByUser = new Map(progress.map(p => [Number(p.userId), p]));

        const users = await db.User.findAll({
            where: { id: userIds, status: true },
            attributes: ['id', 'username', 'email', 'position', 'city'],
            raw: true,
        });

        const now = Date.now();
        const rows = users.map(u => {
            const p = progressByUser.get(Number(u.id));
            const due = userIdToDue.get(Number(u.id));
            const percent = Number(p?.progressPercent || 0);
            const completed = percent >= 100;
            const inProgress = !completed && percent > 0;
            const overdue = !completed && Number.isFinite(due) && due < now;
            const status = completed ? 'COMPLETED' : overdue ? 'OVERDUE' : inProgress ? 'IN_PROGRESS' : 'NOT_STARTED';
            return {
                user: u,
                progressPercent: percent,
                status,
                dueAt: Number.isFinite(due) ? new Date(due).toISOString() : null,
            };
        });

        // Ordena: OVERDUE primeiro, depois IN_PROGRESS, NOT_STARTED, COMPLETED
        const order = { OVERDUE: 0, IN_PROGRESS: 1, NOT_STARTED: 2, COMPLETED: 3 };
        rows.sort((a, b) => (order[a.status] - order[b.status]) || String(a.user.username).localeCompare(String(b.user.username)));

        const counts = {
            total: rows.length,
            completed: rows.filter(r => r.status === 'COMPLETED').length,
            inProgress: rows.filter(r => r.status === 'IN_PROGRESS').length,
            notStarted: rows.filter(r => r.status === 'NOT_STARTED').length,
            overdue: rows.filter(r => r.status === 'OVERDUE').length,
        };

        return { trackSlug: slug, ...counts, users: rows };
    },

    async bulkAdd({ trackSlug, scopeType, scopeValues, required = true, mandatory = false, dueAt = null }) {
        const slug = await ensureTrackExists(trackSlug);
        const st = normalizeScopeType(scopeType);
        const due = normalizeDueAt(dueAt);

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
                mandatory: !!mandatory,
                dueAt: due,
            }));

        if (toCreate.length) await db.AcademyTrackAssignment.bulkCreate(toCreate);

        // dispara notificações em paralelo (background), com proteção contra unhandled rejection.
        for (const v of values) {
            if (!existingSet.has(String(v))) {
                notifyAssigned({ trackSlug: slug, scopeType: st, scopeValue: v, mandatory: !!mandatory, dueAt: due })
                    .catch(err => console.warn('[academy.trackAssignment.bulkAdd] notify failed', err?.message));
            }
        }

        return { ok: true, created: toCreate.length, skipped: values.length - toCreate.length };
    },
};

export default trackAssignmentService;
