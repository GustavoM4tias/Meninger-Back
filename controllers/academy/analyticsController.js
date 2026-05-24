import analyticsService from '../../services/academy/analyticsService.js';

const analyticsController = {
    async itemAnalytics(req, res) {
        try {
            const data = await analyticsService.itemAnalytics({ trackSlug: req.params.slug });
            return res.json(data);
        } catch (err) {
            console.error('[academy.analytics.items]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar analytics.' });
        }
    },
};

export default analyticsController;
