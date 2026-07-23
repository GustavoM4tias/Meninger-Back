// controllers/reservaCancel/reservaCancelController.js
import db from '../../models/sequelize/index.js';
import { processReservaCancel } from '../../services/reservaCancel/ReservaCancelService.js';
import EventLogger from '../../services/reservaCancel/ReservaCancelEventLogger.js';

// ── Webhook (público — chamado pelo CV no cancelamento da reserva) ────────────

export async function receiveWebhook(req, res) {
    const { idreserva } = req.body || {};
    if (!idreserva || !Number.isFinite(Number(idreserva))) {
        return res.status(400).json({ error: 'idreserva é obrigatório.' });
    }

    // Responde na hora e processa em background pra não travar o CV.
    res.status(200).json({ received: true, idreserva: Number(idreserva) });

    processReservaCancel({ idreserva: Number(idreserva), webhookPayload: req.body })
        .catch(err => console.error('[RESERVA-CANCEL_CTRL] Erro no processamento background:', err.message));
}

// ── Simulate (dev/staging only) ───────────────────────────────────────────────

export async function simulateWebhook(req, res) {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Endpoint indisponível em produção.' });
    }
    const { idreserva } = req.body || {};
    if (!idreserva) return res.status(400).json({ error: 'idreserva é obrigatório.' });

    res.status(200).json({ simulated: true, idreserva: Number(idreserva) });
    processReservaCancel({ idreserva: Number(idreserva), webhookPayload: { simulated: true } })
        .catch(err => console.error('[RESERVA-CANCEL_SIM] Erro no processamento simulado:', err.message));
}

// ── Processamento manual (admin — produção permitida) ─────────────────────────

/**
 * Dispara o fluxo manualmente pra uma reserva (backfill de cancelamentos
 * antigos ou reprocesso). Passa por TODAS as mesmas validações do webhook.
 */
export async function processManual(req, res) {
    const { idreserva } = req.body || {};
    if (!idreserva || !Number.isFinite(Number(idreserva))) {
        return res.status(400).json({ error: 'idreserva é obrigatório.' });
    }
    try {
        const history = await processReservaCancel({
            idreserva: Number(idreserva),
            manual: true,
            triggeredBy: req.user?.id || null,
        });
        if (!history) return res.status(409).json({ error: 'Já existe processamento em andamento pra esta reserva.' });
        return res.json({ id: history.id, status: history.status, motivo: history.motivo });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function retryHistoryItem(req, res) {
    try {
        const item = await db.ReservaCancelHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        const history = await processReservaCancel({
            idreserva: item.idreserva,
            manual: true,
            triggeredBy: req.user?.id || null,
        });
        if (!history) return res.status(409).json({ error: 'Já existe processamento em andamento pra esta reserva.' });
        return res.json({ id: history.id, status: history.status, motivo: history.motivo });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

// ── Settings (admin) ──────────────────────────────────────────────────────────

export async function getSettings(req, res) {
    try {
        let s = await db.ReservaCancelSettings.findByPk(1);
        if (!s) s = await db.ReservaCancelSettings.create({ id: 1 });
        return res.json(s.toJSON());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function updateSettings(req, res) {
    try {
        const updates = {};
        if (req.body.active !== undefined) updates.active = !!req.body.active;
        for (const key of ['situacao_pendencia_id', 'situacao_cancelada_id']) {
            if (req.body[key] !== undefined) {
                const n = Number(req.body[key]);
                updates[key] = Number.isFinite(n) && n > 0 ? n : null;
            }
        }
        updates.updated_by = req.user?.id || null;

        let s = await db.ReservaCancelSettings.findByPk(1);
        if (!s) s = await db.ReservaCancelSettings.create({ id: 1, ...updates });
        else await s.update(updates);
        return res.json(s.toJSON());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

// ── History ───────────────────────────────────────────────────────────────────

function buildHistoryWhere(query) {
    const { Op } = db.Sequelize;
    const { status, idreserva, empreendimento, dateFrom, dateTo, q } = query;
    const where = {};

    if (status) {
        const arr = String(status).split(',').map(s => s.trim()).filter(Boolean);
        if (arr.length === 1) where.status = arr[0];
        else if (arr.length > 1) where.status = { [Op.in]: arr };
    }
    if (idreserva) where.idreserva = Number(idreserva);
    if (empreendimento) {
        const arr = String(empreendimento).split(',').map(s => s.trim()).filter(Boolean);
        if (arr.length) where.empreendimento = { [Op.in]: arr };
    }
    if (dateFrom) where.created_at = { ...(where.created_at || {}), [Op.gte]: new Date(`${dateFrom}T00:00:00`) };
    if (dateTo)   where.created_at = { ...(where.created_at || {}), [Op.lte]: new Date(`${dateTo}T23:59:59`) };
    if (q) {
        const like = { [Op.iLike]: `%${String(q).trim()}%` };
        where[Op.or] = [
            { titular_nome: like },
            { unidade_nome: like },
            { contrato_numero: like },
            { motivo: like },
        ];
    }
    return where;
}

export async function listHistory(req, res) {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const where = buildHistoryWhere(req.query);

        const { rows, count } = await db.ReservaCancelHistory.findAndCountAll({
            where,
            order: [['id', 'DESC']],
            limit,
            offset: (page - 1) * limit,
        });
        return res.json({ rows, total: count, page, limit });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function getHistoryStats(req, res) {
    try {
        const where = buildHistoryWhere(req.query);
        const rows = await db.ReservaCancelHistory.findAll({
            where,
            attributes: ['status', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
            group: ['status'],
            raw: true,
        });
        const byStatus = {};
        for (const r of rows) byStatus[r.status] = Number(r.count);
        return res.json({ byStatus });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function getHistoryFacets(req, res) {
    try {
        const rows = await db.ReservaCancelHistory.findAll({
            attributes: [[db.Sequelize.fn('DISTINCT', db.Sequelize.col('empreendimento')), 'empreendimento']],
            where: { empreendimento: { [db.Sequelize.Op.ne]: null } },
            raw: true,
        });
        const empreendimentos = rows.map(r => r.empreendimento).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
        return res.json({ empreendimentos });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function getHistoryItem(req, res) {
    try {
        const item = await db.ReservaCancelHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        return res.json(item);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function listHistoryEvents(req, res) {
    try {
        const item = await db.ReservaCancelHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        // Timeline consolidada da reserva: todas as tentativas + eventos.
        const events = await EventLogger.listByReserva(item.idreserva);
        const attempts = await db.ReservaCancelHistory.findAll({
            where: { idreserva: item.idreserva },
            order: [['id', 'ASC']],
        });
        return res.json({ history: item, events, attempts });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
