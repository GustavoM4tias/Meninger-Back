// services/academy/videoWatchService.js
//
// Tracking de % assistido em items VIDEO. Frontend chama POST .../watch
// periodicamente (a cada N segundos) com {currentSec, durationSec}.
// Service:
//   - Atualiza watchedPercent (monotônico: nunca regride).
//   - Quando atinge >= AUTO_COMPLETE_THRESHOLD (85%), marca o item como
//     concluído via trackService.markProgress.
//   - Idempotente: múltiplas chamadas com o mesmo state não duplicam progresso.

import db from '../../models/sequelize/index.js';
import trackService from './trackService.js';

const AUTO_COMPLETE_THRESHOLD = 85; // %

const videoWatchService = {
    async upsertWatch({ userId, trackSlug, itemId, currentSec, durationSec, ip = null, userAgent = null } = {}) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) throw new Error('Usuário não identificado.');

        const slug = String(trackSlug || '').trim();
        if (!slug) throw new Error('Trilha inválida.');

        const iid = Number(itemId);
        if (!Number.isFinite(iid) || iid <= 0) throw new Error('Item inválido.');

        // Valida que o item existe E é VIDEO E pertence à trilha.
        const item = await db.AcademyTrackItem.findOne({
            where: { id: iid },
            attributes: ['id', 'type', 'trackId', 'required'],
            include: [{ model: db.AcademyTrack, as: 'track', attributes: ['slug'] }],
        });
        if (!item) throw new Error('Item não encontrado.');
        if (String(item.type).toUpperCase() !== 'VIDEO') throw new Error('Item não é VIDEO.');
        if (item.track?.slug !== slug) throw new Error('Item não pertence à trilha informada.');

        const cur = Math.max(0, Math.floor(Number(currentSec) || 0));
        const dur = Math.max(0, Math.floor(Number(durationSec) || 0));
        const reportedPct = dur > 0 ? Math.min(100, Math.round((cur / dur) * 100)) : 0;

        // Busca state anterior. Mantém o maior watchedPercent (monotônico).
        let row = await db.AcademyVideoWatch.findOne({
            where: { userId: uid, itemId: iid },
        });

        if (row) {
            // Monotônico — usuário pode voltar no vídeo mas a marca de "% assistido"
            // só cresce. Isso impede "fraudar" o auto-complete pulando pro final.
            // CONTUDO: se quiser permitir scrub livre + completion ao chegar no fim,
            // poderia trocar para `row.watchedPercent = reportedPct`. Mantemos
            // o comportamento mais conservador para tracking de aprendizagem.
            const newPct = Math.max(row.watchedPercent, reportedPct);
            const justCompleted = !row.autoCompletedAt && newPct >= AUTO_COMPLETE_THRESHOLD;

            await row.update({
                currentSec: cur,
                durationSec: dur || row.durationSec,
                watchedPercent: newPct,
                autoCompletedAt: justCompleted ? new Date() : row.autoCompletedAt,
                lastWatchedAt: new Date(),
            });

            // Auto-complete o item se cruzou o threshold agora.
            if (justCompleted) {
                trackService.markProgress({
                    userId: uid,
                    trackSlug: slug,
                    itemId: iid,
                    completed: true,
                    ip,
                    userAgent,
                }).catch(err => console.warn('[videoWatch] auto-complete failed', err?.message));
            }

            return {
                watchedPercent: newPct,
                currentSec: cur,
                durationSec: row.durationSec,
                autoCompleted: !!row.autoCompletedAt || justCompleted,
            };
        }

        // primeira chamada para este item
        const justCompleted = reportedPct >= AUTO_COMPLETE_THRESHOLD;
        row = await db.AcademyVideoWatch.create({
            userId: uid,
            itemId: iid,
            trackSlug: slug,
            currentSec: cur,
            durationSec: dur,
            watchedPercent: reportedPct,
            autoCompletedAt: justCompleted ? new Date() : null,
            lastWatchedAt: new Date(),
        });

        if (justCompleted) {
            trackService.markProgress({
                userId: uid,
                trackSlug: slug,
                itemId: iid,
                completed: true,
                ip,
                userAgent,
            }).catch(err => console.warn('[videoWatch] auto-complete failed', err?.message));
        }

        return {
            watchedPercent: reportedPct,
            currentSec: cur,
            durationSec: dur,
            autoCompleted: justCompleted,
        };
    },

    async getWatch({ userId, itemId }) {
        const row = await db.AcademyVideoWatch.findOne({
            where: { userId: Number(userId), itemId: Number(itemId) },
            attributes: ['currentSec', 'durationSec', 'watchedPercent', 'autoCompletedAt', 'lastWatchedAt'],
            raw: true,
        });
        return row || null;
    },
};

export default videoWatchService;
export { AUTO_COMPLETE_THRESHOLD };
