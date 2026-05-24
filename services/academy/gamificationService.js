// services/academy/gamificationService.js
//
// XP + Levels + Streaks + Badges.
//
// Filosofia:
//   - awardXp() é a única porta de entrada. Outros services chamam ela.
//   - É idempotente por (user, reason, refKind, refId): mesmo evento não conta 2 vezes.
//   - Após cada award, atualiza streak (D-1 → D, ou reseta) e checa badges.
//
// Level math: level = floor(sqrt(totalXp / 100)) + 1
//   level 1 → 0-99 XP
//   level 2 → 100-399
//   level 3 → 400-899
//   level 4 → 900-1599
//   ... curva quadrática, fácil no começo, vai endurecendo.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

// Tabela de XP por motivo. Mantida aqui para facilitar ajuste de balanceamento.
const XP_AMOUNTS = {
    TRACK_COMPLETED:   200,
    ITEM_COMPLETED:    10,
    QUIZ_PASSED:       50,
    ARTICLE_PUBLISHED: 100,
    TOPIC_CREATED:     20,
    POST_CREATED:      5,
    POST_UPVOTED:      3,   // recebido (autor recebe)
    COMMENT_POSTED:    5,
    RATING_GIVEN:      2,
    DAILY_STREAK:      15,  // bônus por manter streak
};

function computeLevel(totalXp) {
    const xp = Math.max(0, Number(totalXp) || 0);
    return Math.floor(Math.sqrt(xp / 100)) + 1;
}

function xpForNextLevel(currentLevel) {
    // XP necessário para alcançar o NEXT level (currentLevel+1)
    return Math.pow(currentLevel, 2) * 100;
}

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function daysBetween(a, b) {
    return Math.floor((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000);
}

const gamificationService = {
    // Stats do user (lazy-creates a row se não existir).
    async getStats({ userId }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário inválido.');

        let row = await db.AcademyUserXp.findOne({ where: { userId: uid } });
        if (!row) {
            row = await db.AcademyUserXp.create({ userId: uid });
        }

        const level = computeLevel(row.totalXp);
        const nextLevelXp = xpForNextLevel(level);
        const prevLevelXp = xpForNextLevel(level - 1);

        return {
            userId: uid,
            totalXp: row.totalXp,
            level,
            xpInCurrentLevel: row.totalXp - prevLevelXp,
            xpToNextLevel: nextLevelXp - row.totalXp,
            currentStreak: row.currentStreak,
            longestStreak: row.longestStreak,
            lastActivityAt: row.lastActivityAt,
        };
    },

    /**
     * Concede XP por um evento. Idempotente por (user, reason, refKind, refId).
     * Atualiza streak e dispara checagem de badges.
     *
     * @param {object} opts
     * @param {number} opts.userId
     * @param {string} opts.reason     — uma das chaves de XP_AMOUNTS
     * @param {string|null} opts.refKind — ex: 'track', 'item', 'post', 'article'
     * @param {string|null} opts.refId   — id do recurso
     * @param {number|null} opts.amount  — override (raro). Se null, usa XP_AMOUNTS[reason]
     */
    async awardXp({ userId, reason, refKind = null, refId = null, amount = null }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return null; // silencioso — não bloqueia evento original
        if (!reason) return null;

        const xp = Number(amount ?? XP_AMOUNTS[reason]);
        if (!Number.isFinite(xp) || xp <= 0) return null;

        // 1) Anti-dup: checa explicitamente (UNIQUE com COALESCE é criado via
        // ensureAcademySchema mas em ambiente novo pode ainda não estar; fallback
        // defensivo aqui evita XP duplicado).
        const refKindStr = refKind ? String(refKind) : null;
        const refIdStr = refId != null ? String(refId) : null;
        const existing = await db.AcademyXpLog.findOne({
            where: {
                userId: uid,
                reason,
                refKind: refKindStr,
                refId: refIdStr,
            },
            attributes: ['id'],
        });
        if (existing) return { skipped: 'duplicate' };

        try {
            await db.AcademyXpLog.create({
                userId: uid,
                reason,
                amount: xp,
                refKind: refKindStr,
                refId: refIdStr,
            });
        } catch (err) {
            if (err?.name === 'SequelizeUniqueConstraintError') return { skipped: 'duplicate' };
            throw err;
        }

        // 2) Atualiza UserXp (cria se não existe).
        let row = await db.AcademyUserXp.findOne({ where: { userId: uid } });
        if (!row) {
            row = await db.AcademyUserXp.create({ userId: uid, totalXp: 0 });
        }

        const oldLevel = computeLevel(row.totalXp);
        const newTotal = row.totalXp + xp;
        const newLevel = computeLevel(newTotal);

        // 3) Streak: D? consecutivo com qualquer atividade
        const now = new Date();
        let newStreak = row.currentStreak || 0;
        let newLongest = row.longestStreak || 0;
        if (row.lastActivityAt) {
            const diff = daysBetween(row.lastActivityAt, now);
            if (diff === 0) {
                // mesma data — não muda streak
            } else if (diff === 1) {
                newStreak = (newStreak || 0) + 1;
            } else {
                // gap > 1 dia — reseta
                newStreak = 1;
            }
        } else {
            newStreak = 1;
        }
        if (newStreak > newLongest) newLongest = newStreak;

        await row.update({
            totalXp: newTotal,
            level: newLevel,
            currentStreak: newStreak,
            longestStreak: newLongest,
            lastActivityAt: now,
        });

        const result = {
            awarded: xp,
            totalXp: newTotal,
            level: newLevel,
            leveledUp: newLevel > oldLevel,
            currentStreak: newStreak,
            longestStreak: newLongest,
        };

        // 4) Level-up notify
        if (result.leveledUp) {
            NotificationService.notify({
                type: NotificationType.ACADEMY_LEVELED_UP,
                recipients: { users: [uid] },
                title: `🎉 Você subiu para o nível ${newLevel}!`,
                body: `Continue assim — mais ${xpForNextLevel(newLevel) - newTotal} XP para o próximo nível.`,
                data: { level: newLevel, totalXp: newTotal },
                link: '/academy/me',
                importance: 5,
            }).catch(err => console.warn('[gamification.notify level-up]', err?.message));
        }

        // 5) Verifica badges (em background, não bloqueia retorno)
        gamificationService.checkAndAwardBadges({ userId: uid })
            .catch(err => console.warn('[gamification.checkBadges]', err?.message));

        return result;
    },

    /**
     * Avalia regras de badges ATIVAS para o user e concede as que ele acabou
     * de cumprir. Idempotente (UNIQUE em user+badge).
     */
    async checkAndAwardBadges({ userId }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return [];

        const badges = await db.AcademyBadge.findAll({
            where: { status: 'ACTIVE' },
            attributes: ['slug', 'title', 'rule', 'rarity'],
            raw: true,
        });
        if (!badges.length) return [];

        const alreadyOwned = await db.AcademyUserBadge.findAll({
            where: { userId: uid },
            attributes: ['badgeSlug'],
            raw: true,
        });
        const ownedSet = new Set(alreadyOwned.map(b => b.badgeSlug));

        const newlyAwarded = [];
        for (const b of badges) {
            if (ownedSet.has(b.slug)) continue;
            const rule = b.rule || {};
            const passed = await gamificationService.evaluateRule(uid, rule);
            if (passed) {
                try {
                    await db.AcademyUserBadge.create({ userId: uid, badgeSlug: b.slug });
                    newlyAwarded.push(b);
                    NotificationService.notify({
                        type: NotificationType.ACADEMY_BADGE_EARNED,
                        recipients: { users: [uid] },
                        title: `🏅 Conquista desbloqueada: ${b.title}`,
                        body: 'Você ganhou um novo badge no Academy.',
                        data: { badgeSlug: b.slug, rarity: b.rarity },
                        link: '/academy/me',
                        importance: 5,
                    }).catch(err => console.warn('[gamification.notify badge]', err?.message));
                } catch (err) {
                    if (err?.name !== 'SequelizeUniqueConstraintError') {
                        console.warn('[gamification.awardBadge]', err?.message);
                    }
                }
            }
        }
        return newlyAwarded;
    },

    /**
     * Avalia uma regra: { kind, count }.
     * kind in:
     *   TRACK_COMPLETED   — count >= número de trilhas COMPLETED do user
     *   QUIZ_PASSED       — count >= número de quiz attempts com allCorrect=true
     *   ARTICLE_PUBLISHED — count >= artigos publicados pelo user
     *   TOPIC_CREATED     — count >= tópicos criados pelo user
     *   STREAK_DAYS       — count >= longestStreak
     *   XP_TOTAL          — count >= totalXp
     *   UPVOTES_RECEIVED  — count >= soma de upvotes em posts do user
     */
    async evaluateRule(userId, rule) {
        const kind = String(rule?.kind || '').toUpperCase();
        const need = Number(rule?.count || 0);
        if (!kind || !need) return false;

        switch (kind) {
            case 'TRACK_COMPLETED': {
                const n = await db.AcademyUserTrackProgress.count({
                    where: { userId, status: 'COMPLETED' },
                });
                return n >= need;
            }
            case 'QUIZ_PASSED': {
                // distinct items que passou pelo menos 1 vez
                const rows = await db.AcademyUserQuizAttempt.findAll({
                    where: { userId, allCorrect: true },
                    attributes: ['itemId'],
                    group: ['itemId'],
                    raw: true,
                });
                return rows.length >= need;
            }
            case 'ARTICLE_PUBLISHED': {
                const n = await db.AcademyArticle.count({
                    where: { createdByUserId: userId, status: 'PUBLISHED' },
                });
                return n >= need;
            }
            case 'TOPIC_CREATED': {
                const n = await db.AcademyTopic.count({ where: { createdByUserId: userId } });
                return n >= need;
            }
            case 'STREAK_DAYS': {
                const row = await db.AcademyUserXp.findOne({ where: { userId }, attributes: ['longestStreak'], raw: true });
                return Number(row?.longestStreak || 0) >= need;
            }
            case 'XP_TOTAL': {
                const row = await db.AcademyUserXp.findOne({ where: { userId }, attributes: ['totalXp'], raw: true });
                return Number(row?.totalXp || 0) >= need;
            }
            case 'UPVOTES_RECEIVED': {
                const rows = await db.AcademyPost.findAll({
                    where: { createdByUserId: userId },
                    attributes: ['upvotes'],
                    raw: true,
                });
                const total = rows.reduce((s, r) => s + Number(r.upvotes || 0), 0);
                return total >= need;
            }
            default:
                return false;
        }
    },

    async listUserBadges({ userId }) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return { results: [] };

        const rows = await db.AcademyUserBadge.findAll({
            where: { userId: uid },
            attributes: ['badgeSlug', 'awardedAt'],
            include: [{
                model: db.AcademyBadge,
                as: 'badge',
                attributes: ['slug', 'title', 'description', 'icon', 'rarity'],
                required: false,
            }],
            order: [['awardedAt', 'DESC']],
        });

        return {
            results: rows.map(r => {
                const j = r.toJSON();
                return {
                    ...j.badge,
                    awardedAt: j.awardedAt,
                };
            }),
        };
    },
};

export default gamificationService;
export { XP_AMOUNTS };
