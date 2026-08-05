// controllers/about/aboutController.js
// Números ao vivo da tela "Sobre o Office". Somente admin (a rota já exige):
// o conteúdo expõe economia, custo de ferramenta e potencial financeiro.

import { getAboutMetrics } from '../../services/about/aboutMetricsService.js';

export async function getMetrics(req, res) {
    try {
        // ?refresh=1 fura o cache de 30 min quando o admin quer o número do minuto.
        const force = ['1', 'true'].includes(String(req.query.refresh || '').toLowerCase());
        const metrics = await getAboutMetrics({ force });
        return res.json(metrics);
    } catch (err) {
        console.error('[ABOUT_METRICS]', err);
        return res.status(500).json({ error: err.message });
    }
}
