// controllers/comercial/salesClosingController.js
import * as svc from '../../services/comercial/salesClosingService.js';

export async function list(req, res) {
    try {
        const results = await svc.listClosings();
        return res.json({ count: results.length, results });
    } catch (err) {
        console.error('[salesClosing:list]', err);
        return res.status(500).json({ error: 'Erro ao listar fechamentos.' });
    }
}

export async function getOne(req, res) {
    try {
        const closing = await svc.getClosing(req.params.period);
        if (!closing) return res.status(404).json({ error: 'Período não consolidado.' });
        return res.json(closing);
    } catch (err) {
        console.error('[salesClosing:getOne]', err);
        return res.status(400).json({ error: err.message || 'Erro ao buscar fechamento.' });
    }
}

// Admin: congela o mês com as linhas/totais calculados pelo dashboard (front).
export async function consolidate(req, res) {
    try {
        const { lines, totals, notes } = req.body || {};
        const closing = await svc.consolidate({
            period: req.params.period,
            lines,
            totals,
            notes,
            user: req.user
        });
        return res.json({
            period: closing.period,
            version: closing.version,
            consolidated_at: closing.consolidated_at,
            totals: closing.totals
        });
    } catch (err) {
        console.error('[salesClosing:consolidate]', err);
        return res.status(400).json({ error: err.message || 'Erro ao consolidar.' });
    }
}

// Admin: roda a vigilância agora (também roda sozinha após o full sync diário).
export async function runCheck(req, res) {
    try {
        const result = await svc.checkDivergences({ notify: true });
        return res.json(result);
    } catch (err) {
        console.error('[salesClosing:runCheck]', err);
        return res.status(500).json({ error: 'Erro ao verificar divergências.' });
    }
}

export async function reviewDivergence(req, res) {
    try {
        const row = await svc.reviewDivergence(Number(req.params.id), req.user);
        return res.json(row);
    } catch (err) {
        console.error('[salesClosing:reviewDivergence]', err);
        return res.status(400).json({ error: err.message || 'Erro ao revisar divergência.' });
    }
}
