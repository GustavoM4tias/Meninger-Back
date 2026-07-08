// controllers/marketing/metaReportController.js
//
// Relatório de desempenho Meta por PERÍODO (a régua de tempo).
// Lê a série diária local (meta_insights_daily) — nada de chamada à Meta no
// caminho de leitura. Sync/backfill são ações separadas.

import MetaInsightsDailyService from '../../services/marketing/MetaInsightsDailyService.js';

/**
 * GET /marketing/meta-report
 *   ?since=YYYY-MM-DD&until=YYYY-MM-DD          (obrigatórios)
 *   &level=campaign|adset|ad                     (default campaign)
 *   &accounts=act_1,act_2                        (opcional)
 *   &campaign_id=...&adset_id=...                (drill opcional)
 */
export async function report(req, res) {
    try {
        const { since, until } = req.query;
        if (!since || !until) {
            return res.status(400).json({ ok: false, error: 'Parâmetros since/until são obrigatórios (YYYY-MM-DD).' });
        }
        const level = ['campaign', 'adset', 'ad'].includes(req.query.level) ? req.query.level : 'campaign';
        const accountIds = String(req.query.accounts || '')
            .split(',').map(s => s.trim()).filter(Boolean);

        const result = await MetaInsightsDailyService.getReport({
            since, until, level,
            accountIds,
            campaignId: req.query.campaign_id || null,
            adsetId: req.query.adset_id || null,
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-report] report: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** GET /marketing/meta-report/coverage — janela coberta por nível (front decide se pede backfill). */
export async function coverage(req, res) {
    try {
        const result = await MetaInsightsDailyService.getCoverage();
        return res.json({ ok: true, results: result });
    } catch (err) {
        console.error(`❌ [meta-report] coverage: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/**
 * POST /marketing/meta-report/backfill
 * Body: { sinceDays?: number (default 90, max 730), levels?: ['campaign','adset','ad'] }
 * Preenche a série diária retroativamente. Pode demorar (1 chamada paginada
 * por conta+nível) — o front trata como operação longa, igual ao full sync.
 */
export async function backfill(req, res) {
    try {
        const sinceDays = Math.min(Math.max(Number(req.body?.sinceDays) || 90, 1), 730);
        const levelsIn = Array.isArray(req.body?.levels) ? req.body.levels : ['campaign', 'adset', 'ad'];
        const levels = levelsIn.filter(l => ['campaign', 'adset', 'ad'].includes(l));
        const result = await MetaInsightsDailyService.syncDaily({
            sinceDays,
            levels: levels.length ? levels : ['campaign', 'adset', 'ad'],
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-report] backfill: ${err.message}`);
        const detail = err?.response?.data?.error?.message || err.message;
        return res.status(500).json({ ok: false, error: `Erro no backfill da série diária: ${detail}` });
    }
}

export default { report, coverage, backfill };
