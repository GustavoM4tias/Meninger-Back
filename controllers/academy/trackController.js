import trackService from '../../services/academy/trackService.js';
import videoWatchService from '../../services/academy/videoWatchService.js';
import { resolveAudienceForUser } from '../../services/academy/audience.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const trackController = {
    async listTracks(req, res) {
        try {
            const userId = resolveUserId(req);
            // 🔒 audience derivada do user
            const audience = await resolveAudienceForUser(userId);
            const data = await trackService.listTracks({ audience, userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar trilhas.' });
        }
    },

    async getTrack(req, res) {
        try {
            const { slug } = req.params;
            const userId = resolveUserId(req);
            // 🔒 audience derivada do user
            const audience = await resolveAudienceForUser(userId);

            const data = await trackService.getTrack({ slug, audience, userId });
            if (!data) return res.status(404).json({ message: 'Trilha não encontrada.' });

            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.get]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar trilha.' });
        }
    },

    // S5.2: Tracking de vídeo. Frontend envia currentSec/durationSec periódico.
    async trackVideoWatch(req, res) {
        try {
            const { slug } = req.params;
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });

            const { itemId, currentSec, durationSec } = req.body || {};
            const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
            const userAgent = req.headers['user-agent'] || null;

            const data = await videoWatchService.upsertWatch({
                userId,
                trackSlug: slug,
                itemId: Number(itemId),
                currentSec: Number(currentSec),
                durationSec: Number(durationSec),
                ip,
                userAgent,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.videoWatch]', err);
            return res.status(400).json({ message: err.message || 'Erro ao registrar.' });
        }
    },

    // S3.4: marca abertura do item (sem completar) — base de analytics.
    async markOpened(req, res) {
        try {
            const { slug } = req.params;
            const userId = resolveUserId(req);
            const { itemId } = req.body || {};
            const data = await trackService.markOpened({
                userId,
                trackSlug: slug,
                itemId: Number(itemId),
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.markOpened]', err);
            return res.status(400).json({ message: err.message || 'Erro ao registrar abertura.' });
        }
    },

    async markProgress(req, res) {
        try {
            const { slug } = req.params;
            const userId = resolveUserId(req);
            const { itemId, completed = true } = req.body || {};

            // Evidência forense (S1.6): captura IP real (respeita x-forwarded-for via trust proxy)
            // e user-agent. Persistido por item + replicado na evidência do certificado.
            const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const data = await trackService.markProgress({
                userId,
                trackSlug: slug,
                itemId: Number(itemId),
                completed: !!completed,
                ip,
                userAgent,
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.progress]', err);
            return res.status(400).json({ message: err.message || 'Erro ao atualizar progresso.' });
        }
    },
    async submitQuiz(req, res) {
        try {
            const { slug } = req.params;
            const userId = resolveUserId(req);
            const { itemId, answers = {} } = req.body || {};

            // 🔒 allCorrect é calculado SERVER-SIDE. Ignoramos qualquer valor vindo do body.
            const data = await trackService.submitQuizAttempt({
                userId,
                trackSlug: slug,
                itemId: Number(itemId),
                answers,
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.quiz]', err);
            return res.status(400).json({ message: err.message || 'Erro ao salvar quiz.' });
        }
    },

};

export default trackController;
