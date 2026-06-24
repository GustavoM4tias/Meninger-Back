// services/checklist/authProfileService.js
// Perfis de autorização do checklist (admin gerencia). Membros via JSONB user_ids.
import db from '../../models/sequelize/index.js';

const plain = (p) => (p?.get ? p.get({ plain: true }) : p);
const normIds = (arr) => (Array.isArray(arr) ? [...new Set(arr.map(Number).filter(Boolean))] : []);

export async function listProfiles() {
    const rows = await db.ChecklistAuthProfile.findAll({ order: [['name', 'ASC']] });
    return rows.map(plain);
}

export async function createProfile({ payload = {}, userId }) {
    const name = (payload.name || '').trim();
    if (!name) throw new Error('Nome do perfil é obrigatório.');
    const row = await db.ChecklistAuthProfile.create({
        name,
        description: payload.description?.trim() || null,
        user_ids: normIds(payload.user_ids),
        is_active: payload.is_active !== false,
        created_by: userId || null,
        updated_by: userId || null,
    });
    return plain(row);
}

export async function updateProfile({ id, payload = {}, userId }) {
    const row = await db.ChecklistAuthProfile.findByPk(Number(id));
    if (!row) throw new Error('Perfil não encontrado.');
    if ('name' in payload) row.name = (payload.name || '').trim() || row.name;
    if ('description' in payload) row.description = payload.description?.trim() || null;
    if ('user_ids' in payload) row.user_ids = normIds(payload.user_ids);
    if ('is_active' in payload) row.is_active = !!payload.is_active;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

export async function removeProfile({ id }) {
    const row = await db.ChecklistAuthProfile.findByPk(Number(id));
    if (!row) throw new Error('Perfil não encontrado.');
    await row.destroy();
    return { ok: true };
}

// ── Helpers de associação (membros via JSONB) ──
async function activeProfiles() {
    return db.ChecklistAuthProfile.findAll({ where: { is_active: true }, raw: true });
}

export async function profilesForUser(userId) {
    if (!userId) return [];
    const rows = await activeProfiles();
    return rows.filter((p) => (p.user_ids || []).map(Number).includes(Number(userId)));
}

export async function isApprover(userId) {
    return (await profilesForUser(userId)).length > 0;
}

// União dos membros dos perfis informados (p/ notificar ao entrar em aprovação).
export async function approverUserIdsFor(profileIds = []) {
    const ids = normIds(profileIds);
    if (!ids.length) return [];
    const rows = await db.ChecklistAuthProfile.findAll({ where: { id: ids }, raw: true });
    const set = new Set();
    rows.forEach((p) => (p.user_ids || []).forEach((u) => set.add(Number(u))));
    return Array.from(set);
}

// Perfis (raw, com user_ids) por id — usado no recompute da aprovação.
export async function profilesByIds(profileIds = []) {
    const ids = normIds(profileIds);
    if (!ids.length) return [];
    return db.ChecklistAuthProfile.findAll({ where: { id: ids }, raw: true });
}

export default {
    listProfiles, createProfile, updateProfile, removeProfile,
    profilesForUser, isApprover, approverUserIdsFor, profilesByIds,
};
