// services/academy/analyticsService.js
//
// Métricas de engajamento por item da trilha. Útil para o admin identificar:
//   - Quais items "matam" a trilha (alto drop-off, abrem mas não completam)
//   - Quanto tempo o aluno leva em cada item (avgMinutes)
//   - Taxa de aprovação em quizzes
//
// Não persiste agregados — calcula sob demanda em SQL. Para volumes muito
// grandes, depois cacheamos em uma tabela materializada.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

function avgMinutesBetween(openedAt, completedAt) {
    if (!openedAt || !completedAt) return null;
    const diffMs = new Date(completedAt).getTime() - new Date(openedAt).getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) return null;
    return Math.round(diffMs / 60000);
}

const analyticsService = {
    /**
     * Analytics por item de uma trilha. Para cada item:
     *   - openedCount: users que abriram o item
     *   - completedCount: users que concluíram
     *   - dropoffRate: 1 - (completedCount/openedCount)
     *   - avgMinutes: tempo médio entre openedAt e completedAt (apenas dos que completaram)
     *   - quizPassRate: para items QUIZ, % de tentativas que passaram (allCorrect ou scorePercent>=passingScore)
     *   - quizAttempts: total de tentativas registradas
     */
    async itemAnalytics({ trackSlug }) {
        const slug = String(trackSlug || '').trim();
        if (!slug) throw new Error('Trilha inválida.');

        const track = await db.AcademyTrack.findOne({
            where: { slug },
            attributes: ['id'],
            raw: true,
        });
        if (!track) throw new Error('Trilha não encontrada.');

        const items = await db.AcademyTrackItem.findAll({
            where: { trackId: track.id },
            attributes: ['id', 'orderIndex', 'title', 'type', 'required', 'estimatedMinutes', 'payload'],
            order: [['orderIndex', 'ASC']],
            raw: true,
        });

        if (!items.length) return { trackSlug: slug, items: [] };

        const itemIds = items.map(i => Number(i.id));

        // Progresso (opened + completed) por item
        const progressRows = await db.AcademyUserProgress.findAll({
            where: { trackSlug: slug, itemId: { [Op.in]: itemIds } },
            attributes: ['itemId', 'completed', 'openedAt', 'completedAt'],
            raw: true,
        });

        const byItem = new Map(); // itemId → {opened: Set, completed: Set, durations: []}
        for (const r of progressRows) {
            const iid = Number(r.itemId);
            if (!byItem.has(iid)) byItem.set(iid, { openedUsers: new Set(), completedUsers: new Set(), durations: [] });
            const bucket = byItem.get(iid);
            if (r.openedAt) bucket.openedUsers.add(r.itemId);
            if (r.completed) {
                bucket.completedUsers.add(r.itemId);
                const dur = avgMinutesBetween(r.openedAt, r.completedAt);
                if (dur != null) bucket.durations.push(dur);
            }
        }

        // Tentativas de quiz (para items QUIZ)
        const quizItemIds = items.filter(i => String(i.type).toUpperCase() === 'QUIZ').map(i => Number(i.id));
        const quizStatsByItem = new Map();
        if (quizItemIds.length) {
            const attempts = await db.AcademyUserQuizAttempt.findAll({
                where: { trackSlug: slug, itemId: { [Op.in]: quizItemIds } },
                attributes: ['itemId', 'allCorrect', 'scorePercent', 'userId'],
                raw: true,
            });
            // total + best per (user, item)
            const bestByUserItem = new Map();
            for (const a of attempts) {
                const key = `${a.userId}|${a.itemId}`;
                const cur = bestByUserItem.get(key) || 0;
                if (Number(a.scorePercent || 0) > cur) bestByUserItem.set(key, Number(a.scorePercent || 0));
            }

            for (const iid of quizItemIds) {
                const attempts_for_item = attempts.filter(a => Number(a.itemId) === iid);
                const totalAttempts = attempts_for_item.length;
                const uniqueUsers = new Set(attempts_for_item.map(a => Number(a.userId)));

                // passingScore do item
                const item = items.find(i => Number(i.id) === iid);
                const psRaw = Number(item?.payload?.rules?.passingScore);
                const passingScore = Number.isFinite(psRaw) ? Math.max(0, Math.min(100, psRaw)) : 100;

                let passedUsers = 0;
                for (const uid of uniqueUsers) {
                    const best = bestByUserItem.get(`${uid}|${iid}`) || 0;
                    if (best >= passingScore) passedUsers++;
                }

                quizStatsByItem.set(iid, {
                    totalAttempts,
                    uniqueUsers: uniqueUsers.size,
                    passedUsers,
                    passRate: uniqueUsers.size ? Math.round((passedUsers / uniqueUsers.size) * 100) : 0,
                    passingScore,
                });
            }
        }

        const out = items.map(i => {
            const bucket = byItem.get(Number(i.id));
            const openedCount = bucket?.openedUsers.size || 0;
            const completedCount = bucket?.completedUsers.size || 0;
            const dropoffRate = openedCount > 0
                ? Math.round((1 - completedCount / openedCount) * 100)
                : 0;
            const avgMinutes = bucket?.durations.length
                ? Math.round(bucket.durations.reduce((s, x) => s + x, 0) / bucket.durations.length)
                : null;

            const quizStats = quizStatsByItem.get(Number(i.id)) || null;

            return {
                id: i.id,
                orderIndex: i.orderIndex,
                title: i.title,
                type: i.type,
                required: i.required,
                estimatedMinutes: i.estimatedMinutes,
                openedCount,
                completedCount,
                dropoffRate, // % que abriu mas não concluiu
                avgMinutes,
                quiz: quizStats,
            };
        });

        // Stats agregadas da trilha (média de dropoff, etc.)
        const requiredItems = out.filter(i => i.required);
        const avgDropoff = requiredItems.length
            ? Math.round(requiredItems.reduce((s, x) => s + x.dropoffRate, 0) / requiredItems.length)
            : 0;
        const totalEstimatedMinutes = items.reduce((s, x) => s + (Number(x.estimatedMinutes) || 0), 0);

        return {
            trackSlug: slug,
            items: out,
            summary: {
                totalItems: out.length,
                requiredItems: requiredItems.length,
                avgDropoffRate: avgDropoff,
                totalEstimatedMinutes,
            },
        };
    },
};

export default analyticsService;
