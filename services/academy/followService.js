// services/academy/followService.js
//
// Follow polimórfico: user pode seguir USER, TRACK, TOPIC ou CATEGORY.
// Base para o feed personalizado (S4.5) e para resolver destinatários de
// notify quando um conteúdo seguido recebe atualização.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { resolveUserTokens, audiencesWhereLiteral } from './audience.js';

const TARGET_TYPES = ['USER', 'TRACK', 'TOPIC', 'CATEGORY'];

function normalizeType(t) {
    const v = String(t || '').toUpperCase().trim();
    if (!TARGET_TYPES.includes(v)) throw new Error(`targetType inválido: ${v}.`);
    return v;
}

function normalizeRef(ref) {
    const s = String(ref ?? '').trim();
    if (!s) throw new Error('targetRef vazio.');
    return s;
}

// 🔒 Valida o alvo DENTRO da audience do seguidor: trilha/tópico fora do
// público dele responde "não encontrada" — sem confirmar existência de
// conteúdo restrito por sondagem de ids/slugs.
async function validateTarget(type, ref, followerUserId) {
    if (type === 'USER') {
        if (!/^\d+$/.test(ref)) throw new Error('USER alvo deve ser userId numérico.');
        const u = await db.User.findByPk(Number(ref), { attributes: ['id'] });
        if (!u) throw new Error('Usuário não encontrado.');
    } else if (type === 'TRACK') {
        const tokens = await resolveUserTokens(followerUserId);
        const t = await db.AcademyTrack.findOne({
            where: { [Op.and]: [{ slug: ref }, audiencesWhereLiteral(tokens)] },
            attributes: ['id'],
        });
        if (!t) throw new Error('Trilha não encontrada.');
    } else if (type === 'TOPIC') {
        if (!/^\d+$/.test(ref)) throw new Error('TOPIC alvo deve ser id numérico.');
        const tokens = await resolveUserTokens(followerUserId);
        const t = await db.AcademyTopic.findOne({
            where: { [Op.and]: [{ id: Number(ref) }, audiencesWhereLiteral(tokens)] },
            attributes: ['id'],
        });
        if (!t) throw new Error('Tópico não encontrado.');
    } else if (type === 'CATEGORY') {
        // category é livre — KB ou Community. Sem validação estrita.
        if (ref.length > 80) throw new Error('CATEGORY ref muito longo.');
    }
}

const followService = {
    async follow({ userId, targetType, targetRef }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);

        // Não pode seguir a si mesmo.
        if (type === 'USER' && Number(ref) === uid) {
            throw new Error('Você não pode seguir a si mesmo.');
        }

        await validateTarget(type, ref, uid);

        try {
            const created = await db.AcademyFollow.create({
                followerId: uid,
                targetType: type,
                targetRef: ref,
            });
            return { following: true, follow: created.toJSON() };
        } catch (err) {
            if (err?.name === 'SequelizeUniqueConstraintError') {
                // Já segue — idempotente.
                return { following: true, alreadyFollowing: true };
            }
            throw err;
        }
    },

    async unfollow({ userId, targetType, targetRef }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);

        const deleted = await db.AcademyFollow.destroy({
            where: { followerId: uid, targetType: type, targetRef: ref },
        });
        return { following: false, removed: deleted > 0 };
    },

    async isFollowing({ userId, targetType, targetRef }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return false;
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);

        const row = await db.AcademyFollow.findOne({
            where: { followerId: uid, targetType: type, targetRef: ref },
            attributes: ['id'],
        });
        return !!row;
    },

    // Quantos seguem um alvo.
    async followersCount({ targetType, targetRef }) {
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);
        return db.AcademyFollow.count({ where: { targetType: type, targetRef: ref } });
    },

    // Lista de userIds que seguem um alvo (para notify em massa).
    async followerIds({ targetType, targetRef }) {
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);
        const rows = await db.AcademyFollow.findAll({
            where: { targetType: type, targetRef: ref },
            attributes: ['followerId'],
            raw: true,
        });
        return rows.map(r => Number(r.followerId));
    },

    // O que UM user segue. Útil pra construir feed.
    async listByUser({ userId, targetType = null }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return { results: [] };
        const where = { followerId: uid };
        if (targetType) where.targetType = normalizeType(targetType);

        const rows = await db.AcademyFollow.findAll({
            where,
            attributes: ['id', 'targetType', 'targetRef', 'createdAt'],
            order: [['createdAt', 'DESC']],
            raw: true,
        });
        return { results: rows };
    },

    // Bulk: para uma lista de (type, ref), diz quais o user segue.
    // Útil pro frontend renderizar botões "seguir/seguindo" em massa.
    async followingFlagsBulk({ userId, targets = [] }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0 || !targets.length) return new Map();
        const rows = await db.AcademyFollow.findAll({
            where: {
                followerId: uid,
                [Op.or]: targets.map(t => ({
                    targetType: normalizeType(t.targetType),
                    targetRef: normalizeRef(t.targetRef),
                })),
            },
            attributes: ['targetType', 'targetRef'],
            raw: true,
        });
        const m = new Map();
        for (const r of rows) m.set(`${r.targetType}:${r.targetRef}`, true);
        return m;
    },
};

export default followService;
export { TARGET_TYPES };
