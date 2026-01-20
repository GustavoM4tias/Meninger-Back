import trackService from '../../services/academy/trackService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const trackController = {
    async listTracks(req, res) {
        try {
            const audience = req.query.audience || 'BOTH';
            const userId = resolveUserId(req);
            const data = await trackService.listTracks({ audience, userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar trilhas.' });
        }
    }, // <- FALTAVA ESTA VÍRGULA

    async getTrack(req, res) {
        try {
            const { slug } = req.params;
            const audience = req.query.audience || 'BOTH';
            const userId = resolveUserId(req);

            const data = await trackService.getTrack({ slug, audience, userId });
            if (!data) return res.status(404).json({ message: 'Trilha não encontrada.' });

            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.get]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar trilha.' });
        }
    },

    async markProgress(req, res) {
        try {
            const { slug } = req.params;
            const userId = resolveUserId(req);
            const { itemId, completed = true } = req.body || {};

            const data = await trackService.markProgress({
                userId,
                trackSlug: slug,
                itemId: Number(itemId),
                completed: !!completed,
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
            const { itemId, answers = {}, allCorrect = false } = req.body || {};

            const data = await trackService.submitQuizAttempt({
                userId,
                trackSlug: slug,
                itemId: Number(itemId),
                answers,
                allCorrect: !!allCorrect,
            });

            return res.json(data);
        } catch (err) {
            console.error('[academy.tracks.quiz]', err);
            return res.status(400).json({ message: err.message || 'Erro ao salvar quiz.' });
        }
    },

};

export default trackController;
