// services/academy/ratingsService.js
//
// Ratings polimórficos (ARTICLE | TRACK). Cada user dá UM rating por target
// (UNIQUE constraint). Service expõe estatísticas (avg, total, distribution).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { resolveAudienceForUser, audienceWhere } from './audience.js';
import gamificationService from './gamificationService.js';

const TARGET_TYPES = ['ARTICLE', 'TRACK'];

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

function normalizeStars(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error('stars deve ser inteiro entre 1 e 5.');
    return Math.round(n);
}

async function validateTarget(type, ref, { userId = null } = {}) {
    // 🔒 Audience check: usuário só pode ratar o que enxerga.
    const audience = await resolveAudienceForUser(userId);
    const audWhere = audienceWhere(audience);

    if (type === 'ARTICLE') {
        if (!/^\d+$/.test(ref)) throw new Error('ARTICLE alvo deve ser id numérico.');
        const a = await db.AcademyArticle.findOne({
            where: { id: Number(ref), status: 'PUBLISHED', ...audWhere },
            attributes: ['id'],
        });
        if (!a) throw new Error('Artigo não encontrado.');
    } else if (type === 'TRACK') {
        const t = await db.AcademyTrack.findOne({
            where: { slug: ref, status: 'PUBLISHED', ...audWhere },
            attributes: ['id'],
        });
        if (!t) throw new Error('Trilha não encontrada.');
    }
}

const ratingsService = {
    /**
     * Cria ou atualiza rating do user (upsert via UNIQUE).
     */
    async rate({ userId, targetType, targetRef, stars, comment = null }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);
        const s = normalizeStars(stars);
        const c = comment ? String(comment).trim().slice(0, 2000) : null;

        await validateTarget(type, ref, { userId: uid });

        // Race-safe: tenta INSERT primeiro. Se colide (já existe rating do user
        // para este target), UPDATE. Cobre o caso de 2 requests concorrentes
        // do mesmo user que ambos chamaram findOne e veriam null.
        try {
            const created = await db.AcademyRating.create({
                userId: uid,
                targetType: type,
                targetRef: ref,
                stars: s,
                comment: c,
            });

            // S5.1: XP por dar rating (idempotente por target)
            gamificationService.awardXp({
                userId: uid,
                reason: 'RATING_GIVEN',
                refKind: 'rating',
                refId: `${type}:${ref}`,
            }).catch(err => console.warn('[gamification.ratingGiven]', err?.message));

            return { rating: created.toJSON(), changed: true, isUpdate: false };
        } catch (err) {
            if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
            // já existe — atualiza
            const existing = await db.AcademyRating.findOne({
                where: { userId: uid, targetType: type, targetRef: ref },
            });
            if (!existing) throw err; // não deveria acontecer; rethrow original
            existing.stars = s;
            existing.comment = c;
            await existing.save();
            return { rating: existing.toJSON(), changed: true, isUpdate: true };
        }
    },

    async removeMine({ userId, targetType, targetRef }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);

        const deleted = await db.AcademyRating.destroy({
            where: { userId: uid, targetType: type, targetRef: ref },
        });
        return { removed: deleted > 0 };
    },

    /**
     * Estatísticas agregadas:
     *   avg, total, distribution: { 1, 2, 3, 4, 5 }, myRating: { stars, comment } | null
     */
    async stats({ targetType, targetRef, userId = null }) {
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);

        const rows = await db.AcademyRating.findAll({
            where: { targetType: type, targetRef: ref },
            attributes: ['userId', 'stars', 'comment', 'updatedAt'],
            raw: true,
        });

        const total = rows.length;
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let sum = 0;
        for (const r of rows) {
            distribution[r.stars] = (distribution[r.stars] || 0) + 1;
            sum += Number(r.stars || 0);
        }
        const avg = total ? Math.round((sum / total) * 100) / 100 : 0;

        let myRating = null;
        if (userId) {
            const mine = rows.find(r => Number(r.userId) === Number(userId));
            if (mine) myRating = { stars: mine.stars, comment: mine.comment, updatedAt: mine.updatedAt };
        }

        return {
            targetType: type,
            targetRef: ref,
            total,
            avg,
            distribution,
            myRating,
        };
    },

    /**
     * Lista pública de reviews (com comentário) para um target.
     * Não inclui ratings sem comentário (puro estrela).
     */
    async listReviews({ targetType, targetRef, page = 1, pageSize = 20 }) {
        const type = normalizeType(targetType);
        const ref = normalizeRef(targetRef);

        const safePage = Math.max(1, Number(page) || 1);
        const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const offset = (safePage - 1) * safePageSize;

        const { rows, count } = await db.AcademyRating.findAndCountAll({
            where: {
                targetType: type,
                targetRef: ref,
                comment: { [Op.ne]: null },
            },
            attributes: ['id', 'userId', 'stars', 'comment', 'updatedAt', 'createdAt'],
            include: db.User ? [
                { model: db.User, as: 'user', attributes: ['id', 'username'], required: false },
            ] : [],
            order: [['updatedAt', 'DESC']],
            limit: safePageSize,
            offset,
        });

        return {
            page: safePage,
            pageSize: safePageSize,
            total: count,
            results: rows.map(r => {
                const j = r.toJSON();
                if (j.user) j.user = { id: j.user.id, username: j.user.username };
                return j;
            }),
        };
    },

    // Bulk: para uma lista de targets, devolve {avg, total} de cada.
    // Útil pro frontend renderizar estrelas em lista de artigos/trilhas.
    async statsBulk({ targets = [] }) {
        if (!targets.length) return new Map();

        const orConds = targets.map(t => ({
            targetType: normalizeType(t.targetType),
            targetRef: normalizeRef(t.targetRef),
        }));

        const rows = await db.AcademyRating.findAll({
            where: { [Op.or]: orConds },
            attributes: ['targetType', 'targetRef', 'stars'],
            raw: true,
        });

        const m = new Map();
        for (const r of rows) {
            const key = `${r.targetType}:${r.targetRef}`;
            const cur = m.get(key) || { total: 0, sum: 0 };
            cur.total++;
            cur.sum += Number(r.stars || 0);
            m.set(key, cur);
        }

        // Materializa avg
        const out = new Map();
        for (const t of targets) {
            const key = `${normalizeType(t.targetType)}:${normalizeRef(t.targetRef)}`;
            const cur = m.get(key) || { total: 0, sum: 0 };
            const avg = cur.total ? Math.round((cur.sum / cur.total) * 100) / 100 : 0;
            out.set(key, { total: cur.total, avg });
        }
        return out;
    },
};

export default ratingsService;
export { TARGET_TYPES };
