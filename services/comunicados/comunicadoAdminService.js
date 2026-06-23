import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

const KINDS = ['INFORMATIVO', 'OBRIGATORIO', 'URGENTE'];
const SCOPES = ['ROLE', 'POSITION', 'DEPARTMENT', 'CITY', 'USER'];

const normStr = (v) => String(v ?? '').trim();

function normalizeKind(v) {
    const k = String(v || '').toUpperCase().trim();
    return KINDS.includes(k) ? k : 'INFORMATIVO';
}
function normalizePriority(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 10;
    return Math.max(1, Math.min(999, Math.round(n)));
}
function normalizeDate(v) {
    if (v === null || v === '' || v === undefined) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}
function normalizeChannels(input) {
    const c = input && typeof input === 'object' ? input : {};
    return { inapp: c.inapp !== false, email: !!c.email, whatsapp: !!c.whatsapp };
}
function normalizeScopeType(v) {
    const t = String(v || '').toUpperCase().trim();
    if (!SCOPES.includes(t)) throw new Error('scopeType inválido (ROLE | POSITION | DEPARTMENT | CITY | USER).');
    return t;
}

// Resolve userIds afetados por um escopo (mesma lógica de público-alvo das trilhas
// do Academy — copiada aqui para manter o Mural autossuficiente, fora do Academy).
async function resolveAffectedUserIds({ scopeType, scopeValue }) {
    if (scopeType === 'USER') {
        const uid = Number(scopeValue);
        return Number.isFinite(uid) && uid > 0 ? [uid] : [];
    }
    const where = { status: true };
    if (scopeType === 'ROLE') {
        where.role = normStr(scopeValue);
    } else if (scopeType === 'POSITION') {
        const pos = await db.Position.findOne({ where: { code: normStr(scopeValue) }, attributes: ['name'], raw: true });
        if (!pos?.name) return [];
        where.position = pos.name;
    } else if (scopeType === 'DEPARTMENT') {
        const positions = await db.Position.findAll({ where: { department_id: Number(scopeValue) }, attributes: ['name'], raw: true });
        const names = positions.map((p) => p.name).filter(Boolean);
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
    return users.map((u) => Number(u.id));
}

async function validateScope(scopeType, scopeValue) {
    const v = normStr(scopeValue);
    if (!v) throw new Error('scopeValue inválido.');
    if (scopeType === 'USER') {
        if (!/^\d+$/.test(v)) throw new Error('USER precisa ser id numérico.');
        if (!(await db.User.findByPk(Number(v), { attributes: ['id'] }))) throw new Error('Usuário não encontrado.');
    } else if (scopeType === 'DEPARTMENT') {
        if (!/^\d+$/.test(v)) throw new Error('DEPARTMENT precisa ser id numérico.');
        if (!(await db.Department.findByPk(Number(v), { attributes: ['id'] }))) throw new Error('Departamento não encontrado.');
    } else if (scopeType === 'CITY') {
        if (!/^\d+$/.test(v)) throw new Error('CITY precisa ser id numérico.');
        if (!(await db.UserCity.findByPk(Number(v), { attributes: ['id'] }))) throw new Error('Cidade não encontrada.');
    } else if (scopeType === 'POSITION') {
        if (!(await db.Position.findOne({ where: { code: v }, attributes: ['id'] }))) throw new Error('Cargo (code) não encontrado.');
    } else if (scopeType === 'ROLE') {
        if (!['admin', 'user'].includes(v)) throw new Error('ROLE inválida (admin | user).');
    }
}

async function loadAssignments(comunicadoId) {
    return db.ComunicadoAssignment.findAll({
        where: { comunicadoId },
        attributes: ['id', 'scopeType', 'scopeValue'],
        order: [['id', 'ASC']],
        raw: true,
    });
}

async function ackStats(comunicadoId) {
    const recipients = await db.ComunicadoReceipt.count({ where: { comunicadoId } });
    const acked = await db.ComunicadoReceipt.count({ where: { comunicadoId, ackedAt: { [Op.ne]: null } } });
    return { recipients, acked, pending: recipients - acked };
}

// Notificação ao publicar (background). Aplica os canais escolhidos no comunicado;
// comunicados oficiais (OBRIGATORIO/URGENTE) ignoram as preferências do usuário
// (bypassPrefs) para garantir a entrega da comunicação obrigatória.
async function notifyComunicado(row, userIds) {
    if (!userIds?.length) return;
    const tag = row.kind === 'OBRIGATORIO' ? '[Obrigatório] ' : row.kind === 'URGENTE' ? '[Urgente] ' : '';
    const plain = String(row.body || '').replace(/[#*_>`[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const snippet = plain.slice(0, 180) + (plain.length > 180 ? '…' : '');
    const body = row.requiresAck ? `${snippet}\n\nConfirme a leitura no mural de avisos.` : snippet;
    const oficial = row.kind === 'OBRIGATORIO' || row.kind === 'URGENTE';
    await NotificationService.notify({
        type: NotificationType.COMUNICADO_PUBLISHED,
        recipients: { users: userIds },
        title: `${tag}${row.title}`,
        body,
        data: { comunicadoId: row.id, kind: row.kind, requiresAck: !!row.requiresAck },
        link: '/mural',
        importance: row.kind === 'URGENTE' ? 9 : row.kind === 'OBRIGATORIO' ? 8 : 5,
        channels: row.channels || { inapp: true, email: true, whatsapp: false },
        bypassPrefs: oficial,
    });
}

const comunicadoAdminService = {
    async list({ status } = {}) {
        const where = {};
        if (status) where.status = String(status).toUpperCase().trim();
        const rows = await db.Comunicado.findAll({
            where,
            order: [['pinned', 'DESC'], ['priority', 'ASC'], ['updatedAt', 'DESC']],
        });
        const results = [];
        for (const r of rows) {
            // eslint-disable-next-line no-await-in-loop
            const stats = r.status === 'PUBLISHED' ? await ackStats(r.id) : { recipients: 0, acked: 0, pending: 0 };
            results.push({ ...r.toJSON(), stats });
        }
        return { results };
    },

    async get({ id }) {
        const row = await db.Comunicado.findByPk(Number(id));
        if (!row) throw new Error('Comunicado não encontrado.');
        const assignments = await loadAssignments(row.id);
        const stats = await ackStats(row.id);
        return { comunicado: { ...row.toJSON(), assignments, stats } };
    },

    async create({ payload, userId }) {
        const title = normStr(payload?.title);
        if (!title) throw new Error('Título é obrigatório.');
        const created = await db.Comunicado.create({
            title,
            body: String(payload?.body ?? ''),
            kind: normalizeKind(payload?.kind),
            requiresAck: !!payload?.requiresAck,
            pinned: !!payload?.pinned,
            priority: normalizePriority(payload?.priority ?? 10),
            status: 'DRAFT',
            startsAt: normalizeDate(payload?.startsAt),
            endsAt: normalizeDate(payload?.endsAt),
            channels: normalizeChannels(payload?.channels),
            link: normStr(payload?.link) || null,
            createdByUserId: userId || null,
            updatedByUserId: userId || null,
        });
        if (Array.isArray(payload?.assignments) && payload.assignments.length) {
            await this.setAssignments({ id: created.id, assignments: payload.assignments });
        }
        return this.get({ id: created.id });
    },

    async update({ id, payload, userId }) {
        const row = await db.Comunicado.findByPk(Number(id));
        if (!row) throw new Error('Comunicado não encontrado.');
        if (payload?.title !== undefined) {
            const t = normStr(payload.title);
            if (!t) throw new Error('Título é obrigatório.');
            row.title = t;
        }
        if (payload?.body !== undefined) row.body = String(payload.body ?? '');
        if (payload?.kind !== undefined) row.kind = normalizeKind(payload.kind);
        if (payload?.requiresAck !== undefined) row.requiresAck = !!payload.requiresAck;
        if (payload?.pinned !== undefined) row.pinned = !!payload.pinned;
        if (payload?.priority !== undefined) row.priority = normalizePriority(payload.priority);
        if (payload?.startsAt !== undefined) row.startsAt = normalizeDate(payload.startsAt);
        if (payload?.endsAt !== undefined) row.endsAt = normalizeDate(payload.endsAt);
        if (payload?.channels !== undefined) row.channels = normalizeChannels(payload.channels);
        if (payload?.link !== undefined) row.link = normStr(payload.link) || null;
        row.updatedByUserId = userId || row.updatedByUserId;
        await row.save();
        if (Array.isArray(payload?.assignments)) {
            await this.setAssignments({ id: row.id, assignments: payload.assignments });
        }
        return this.get({ id: row.id });
    },

    // Substitui o conjunto de público-alvo (assignments) do comunicado.
    async setAssignments({ id, assignments }) {
        const row = await db.Comunicado.findByPk(Number(id), { attributes: ['id'] });
        if (!row) throw new Error('Comunicado não encontrado.');
        const list = Array.isArray(assignments) ? assignments : [];
        const norm = [];
        const seen = new Set();
        for (const a of list) {
            const scopeType = normalizeScopeType(a?.scopeType);
            const scopeValue = normStr(a?.scopeValue);
            // eslint-disable-next-line no-await-in-loop
            await validateScope(scopeType, scopeValue);
            const key = `${scopeType}|${scopeValue}`;
            if (seen.has(key)) continue;
            seen.add(key);
            norm.push({ comunicadoId: row.id, scopeType, scopeValue });
        }
        await db.sequelize.transaction(async (t) => {
            await db.ComunicadoAssignment.destroy({ where: { comunicadoId: row.id }, transaction: t });
            if (norm.length) await db.ComunicadoAssignment.bulkCreate(norm, { transaction: t });
        });
        return { ok: true, count: norm.length };
    },

    // Resolve todos os destinatários (userIds) a partir dos assignments.
    async resolveRecipients(comunicadoId) {
        const assigns = await loadAssignments(comunicadoId);
        const set = new Set();
        for (const a of assigns) {
            // eslint-disable-next-line no-await-in-loop
            const ids = await resolveAffectedUserIds({ scopeType: a.scopeType, scopeValue: a.scopeValue });
            ids.forEach((uid) => set.add(uid));
        }
        return Array.from(set);
    },

    async publish({ id, userId }) {
        const row = await db.Comunicado.findByPk(Number(id));
        if (!row) throw new Error('Comunicado não encontrado.');

        const userIds = await this.resolveRecipients(row.id);
        if (!userIds.length) {
            throw new Error('Nenhum destinatário — defina ao menos um público-alvo (responsáveis/departamentos) antes de publicar.');
        }

        await db.sequelize.transaction(async (t) => {
            const recs = userIds.map((uid) => ({ comunicadoId: row.id, userId: uid }));
            await db.ComunicadoReceipt.bulkCreate(recs, { ignoreDuplicates: true, transaction: t });
            row.status = 'PUBLISHED';
            row.publishedAt = row.publishedAt || new Date();
            row.updatedByUserId = userId || row.updatedByUserId;
            await row.save({ transaction: t });
        });

        notifyComunicado(row, userIds).catch((err) => console.warn('[comunicado.publish] notify failed', err?.message));

        return this.get({ id: row.id });
    },

    // Re-resolve o público-alvo e materializa novos destinatários sem duplicar os
    // existentes (mantém as ciências já registradas). Útil quando alguém entra no
    // departamento depois da publicação. Não re-notifica os antigos.
    async refreshRecipients({ id, userId, notify = true } = {}) {
        const row = await db.Comunicado.findByPk(Number(id));
        if (!row) throw new Error('Comunicado não encontrado.');
        if (row.status !== 'PUBLISHED') throw new Error('Só comunicados publicados podem atualizar destinatários.');

        const userIds = await this.resolveRecipients(row.id);
        const existing = await db.ComunicadoReceipt.findAll({
            where: { comunicadoId: row.id }, attributes: ['userId'], raw: true,
        });
        const known = new Set(existing.map((r) => Number(r.userId)));
        const fresh = userIds.filter((uid) => !known.has(uid));
        if (fresh.length) {
            await db.ComunicadoReceipt.bulkCreate(
                fresh.map((uid) => ({ comunicadoId: row.id, userId: uid })),
                { ignoreDuplicates: true },
            );
            if (notify) {
                notifyComunicado(row, fresh).catch((err) => console.warn('[comunicado.refresh] notify failed', err?.message));
            }
        }
        if (userId) { row.updatedByUserId = userId; await row.save(); }
        return { ok: true, added: fresh.length, total: userIds.length };
    },

    async setStatus({ id, status, userId }) {
        const s = String(status || '').toUpperCase().trim();
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(s)) throw new Error('status inválido (DRAFT | PUBLISHED | ARCHIVED).');
        if (s === 'PUBLISHED') return this.publish({ id, userId });
        const row = await db.Comunicado.findByPk(Number(id));
        if (!row) throw new Error('Comunicado não encontrado.');
        row.status = s;
        row.updatedByUserId = userId || row.updatedByUserId;
        await row.save();
        return this.get({ id: row.id });
    },

    async remove({ id }) {
        const row = await db.Comunicado.findByPk(Number(id));
        if (!row) throw new Error('Comunicado não encontrado.');
        await db.sequelize.transaction(async (t) => {
            await db.ComunicadoAssignment.destroy({ where: { comunicadoId: row.id }, transaction: t });
            await db.ComunicadoReceipt.destroy({ where: { comunicadoId: row.id }, transaction: t });
            await row.destroy({ transaction: t });
        });
        return { ok: true };
    },

    // Painel de aderência: quem deu ciência × quem falta.
    async adherence({ id }) {
        const row = await db.Comunicado.findByPk(Number(id), { attributes: ['id', 'title', 'requiresAck', 'status'] });
        if (!row) throw new Error('Comunicado não encontrado.');
        const receipts = await db.ComunicadoReceipt.findAll({
            where: { comunicadoId: row.id },
            attributes: ['userId', 'ackedAt'],
            raw: true,
        });
        const userIds = receipts.map((r) => Number(r.userId));
        const users = userIds.length
            ? await db.User.findAll({ where: { id: userIds }, attributes: ['id', 'username', 'email', 'position', 'city'], raw: true })
            : [];
        const byId = new Map(users.map((u) => [Number(u.id), u]));
        const rows = receipts.map((r) => ({
            user: byId.get(Number(r.userId)) || { id: r.userId, username: `#${r.userId}` },
            acked: !!r.ackedAt,
            ackedAt: r.ackedAt || null,
        }));
        rows.sort((a, b) => (Number(a.acked) - Number(b.acked)) || String(a.user.username).localeCompare(String(b.user.username)));
        return {
            comunicado: { id: row.id, title: row.title, requiresAck: row.requiresAck, status: row.status },
            total: rows.length,
            acked: rows.filter((r) => r.acked).length,
            pending: rows.filter((r) => !r.acked).length,
            users: rows,
        };
    },
};

export default comunicadoAdminService;
