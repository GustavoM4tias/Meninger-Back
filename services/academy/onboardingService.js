// services/academy/onboardingService.js
//
// Regras de onboarding que auto-atribuem trilhas a novos usuários (ou a users
// que mudaram de cargo/cidade). O scheduler diário percorre cada rule ATIVA e
// cria assignments faltantes — idempotente por (track, USER scope).
//
// Casos de uso:
//   - "Todo novo corretor recebe a trilha 'Boas-vindas Comercial' com prazo 15 dias"
//   - "Todo admin recebe trilha 'Compliance Anual'"
//   - "Usuários da cidade Curitiba recebem trilha 'PR — Marketing Regional'"

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function normStr(v) { return String(v ?? '').trim(); }

function normalizeScopeType(v) {
    const t = String(v || '').toUpperCase().trim();
    const allowed = ['ROLE', 'POSITION', 'DEPARTMENT', 'CITY', 'ALL'];
    if (!allowed.includes(t)) throw new Error('scopeType inválido.');
    return t;
}

async function resolveUserIdsForScope({ scopeType, scopeValue }) {
    const where = { status: true };

    if (scopeType === 'ALL') {
        // sem filtro
    } else if (scopeType === 'ROLE') {
        where.role = normStr(scopeValue);
    } else if (scopeType === 'POSITION') {
        const pos = await db.Position.findOne({
            where: { code: normStr(scopeValue) },
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

const onboardingService = {
    async list() {
        const rows = await db.AcademyOnboardingRule.findAll({
            attributes: ['id', 'scopeType', 'scopeValue', 'trackSlug', 'mandatory', 'dueDays', 'active', 'createdAt', 'updatedAt'],
            order: [['createdAt', 'DESC']],
            raw: true,
        });
        return { results: rows };
    },

    async create({ payload }) {
        const scopeType = normalizeScopeType(payload?.scopeType);
        let scopeValue = scopeType === 'ALL' ? null : normStr(payload?.scopeValue);
        if (scopeType !== 'ALL' && !scopeValue) throw new Error('scopeValue obrigatório.');

        const trackSlug = normStr(payload?.trackSlug);
        if (!trackSlug) throw new Error('trackSlug obrigatório.');
        const track = await db.AcademyTrack.findOne({ where: { slug: trackSlug }, attributes: ['id'] });
        if (!track) throw new Error('Trilha não encontrada.');

        const mandatory = payload?.mandatory === true;
        const dueDays = payload?.dueDays != null
            ? Math.max(1, Math.min(365, Number(payload.dueDays)))
            : null;
        const active = payload?.active !== false;

        const created = await db.AcademyOnboardingRule.create({
            scopeType,
            scopeValue,
            trackSlug,
            mandatory,
            dueDays,
            active,
        });
        return { rule: created.toJSON() };
    },

    async update({ id, payload }) {
        const row = await db.AcademyOnboardingRule.findByPk(Number(id));
        if (!row) throw new Error('Regra não encontrada.');

        if (payload?.scopeType !== undefined) row.scopeType = normalizeScopeType(payload.scopeType);
        if (payload?.scopeValue !== undefined) {
            row.scopeValue = row.scopeType === 'ALL' ? null : normStr(payload.scopeValue);
        }
        if (payload?.trackSlug !== undefined) row.trackSlug = normStr(payload.trackSlug);
        if (payload?.mandatory !== undefined) row.mandatory = !!payload.mandatory;
        if (payload?.dueDays !== undefined) {
            row.dueDays = payload.dueDays != null
                ? Math.max(1, Math.min(365, Number(payload.dueDays)))
                : null;
        }
        if (payload?.active !== undefined) row.active = !!payload.active;

        await row.save();
        return { rule: row.toJSON() };
    },

    async remove({ id }) {
        const row = await db.AcademyOnboardingRule.findByPk(Number(id));
        if (!row) throw new Error('Regra não encontrada.');
        await row.destroy();
        return { ok: true };
    },

    /**
     * Aplica TODAS as regras ativas: para cada usuário que satisfaz a regra,
     * cria assignment USER scope SE ainda não existe. Idempotente.
     *
     * Performance: para >100k users, virar isso em SQL puro. Por agora,
     * O(rules * users_in_scope) com batch inserts.
     */
    async applyAll() {
        const rules = await db.AcademyOnboardingRule.findAll({ where: { active: true }, raw: true });
        if (!rules.length) return { rulesApplied: 0, assignmentsCreated: 0 };

        let assignmentsCreated = 0;

        for (const rule of rules) {
            try {
                // 1) Lista users no escopo
                const userIds = await resolveUserIdsForScope({
                    scopeType: rule.scopeType,
                    scopeValue: rule.scopeValue,
                });
                if (!userIds.length) continue;

                // 2) Lista users que JÁ têm assignment USER scope desta trilha
                const existing = await db.AcademyTrackAssignment.findAll({
                    where: {
                        trackSlug: rule.trackSlug,
                        scopeType: 'USER',
                        scopeValue: { [Op.in]: userIds.map(String) },
                    },
                    attributes: ['scopeValue'],
                    raw: true,
                });
                const existingSet = new Set(existing.map(e => String(e.scopeValue)));

                // 3) Cria assignments faltantes
                const toCreate = userIds
                    .filter(uid => !existingSet.has(String(uid)))
                    .map(uid => {
                        const dueAt = rule.dueDays
                            ? new Date(Date.now() + rule.dueDays * 86400000)
                            : null;
                        return {
                            trackSlug: rule.trackSlug,
                            scopeType: 'USER',
                            scopeValue: String(uid),
                            required: true,
                            mandatory: !!rule.mandatory,
                            dueAt,
                        };
                    });

                if (toCreate.length) {
                    await db.AcademyTrackAssignment.bulkCreate(toCreate, { ignoreDuplicates: true });
                    assignmentsCreated += toCreate.length;
                }
            } catch (err) {
                console.warn(`[onboarding] rule ${rule.id} failed:`, err?.message);
            }
        }

        return { rulesApplied: rules.length, assignmentsCreated };
    },

    /**
     * Aplica regras para 1 user específico. Chamado quando criamos User OR
     * quando atualizamos role/position/city. Otimização: não percorre todos.
     */
    async applyForUser({ userId }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return { assignmentsCreated: 0 };

        const user = await db.User.findByPk(uid, {
            attributes: ['id', 'role', 'position', 'city', 'status'],
            raw: true,
        });
        if (!user || !user.status) return { assignmentsCreated: 0 };

        const rules = await db.AcademyOnboardingRule.findAll({ where: { active: true }, raw: true });
        let created = 0;

        for (const rule of rules) {
            const userIds = await resolveUserIdsForScope({
                scopeType: rule.scopeType,
                scopeValue: rule.scopeValue,
            });
            if (!userIds.includes(uid)) continue;

            const existing = await db.AcademyTrackAssignment.findOne({
                where: {
                    trackSlug: rule.trackSlug,
                    scopeType: 'USER',
                    scopeValue: String(uid),
                },
            });
            if (existing) continue;

            const dueAt = rule.dueDays
                ? new Date(Date.now() + rule.dueDays * 86400000)
                : null;

            try {
                await db.AcademyTrackAssignment.create({
                    trackSlug: rule.trackSlug,
                    scopeType: 'USER',
                    scopeValue: String(uid),
                    required: true,
                    mandatory: !!rule.mandatory,
                    dueAt,
                });
                created++;
            } catch (err) {
                if (err?.name !== 'SequelizeUniqueConstraintError') {
                    console.warn(`[onboarding.applyForUser] rule ${rule.id}:`, err?.message);
                }
            }
        }

        return { assignmentsCreated: created };
    },
};

export default onboardingService;
