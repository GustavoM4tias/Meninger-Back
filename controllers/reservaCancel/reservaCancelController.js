// controllers/reservaCancel/reservaCancelController.js
import db from '../../models/sequelize/index.js';
import { processReservaCancel } from '../../services/reservaCancel/ReservaCancelService.js';
import EventLogger from '../../services/reservaCancel/ReservaCancelEventLogger.js';
import {
    fetchCvEtapaByReserva,
    resolveCvEtapaFilter,
    applyCvIdsToWhere,
    fetchCvEtapaFacets,
} from '../../lib/cvEtapaLookup.js';

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

function statusArrFromQuery(query) {
    const arr = String(query?.status || '').split(',').map(s => s.trim()).filter(Boolean);
    return arr.length ? arr : null;
}

function buildHistoryWhere(query, { skipStatus = false } = {}) {
    const { Op } = db.Sequelize;
    const { idreserva, empreendimento, dateFrom, dateTo, q } = query;
    const where = {};

    const statusArr = skipStatus ? null : statusArrFromQuery(query);
    if (statusArr) {
        if (statusArr.length === 1) where.status = statusArr[0];
        else where.status = { [Op.in]: statusArr };
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

// ── Ordenação (whitelist) ─────────────────────────────────────────────────────
// Chaves da UI → atributo do model. Default: caso mais recente primeiro.
const SORT_MAP = {
    caso: 'id',
    reserva: 'idreserva',
    titular: 'titular_nome',
    unidade: 'unidade_nome',
    contrato: 'contrato_numero',
    status: 'status',
    quando: 'createdAt',
};
const NUMERIC_SORT = new Set(['id', 'idreserva']);
const DATE_SORT = new Set(['createdAt']);

function sortSpec(query) {
    return {
        key: SORT_MAP[String(query.sortBy || '')] || 'id',
        dir: String(query.sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC',
    };
}

/** Ordena em memória (caminho agrupado, que trabalha sobre toJSON()). */
function sortRows(list, { key, dir }) {
    const mult = dir === 'ASC' ? 1 : -1;
    return list.sort((a, b) => {
        let va = key === 'createdAt' ? (a.createdAt ?? a.created_at) : a[key];
        let vb = key === 'createdAt' ? (b.createdAt ?? b.created_at) : b[key];
        if (NUMERIC_SORT.has(key)) { va = Number(va) || 0; vb = Number(vb) || 0; }
        else if (DATE_SORT.has(key)) { va = va ? new Date(va).getTime() : 0; vb = vb ? new Date(vb).getTime() : 0; }
        else { va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase(); }
        if (va < vb) return -mult;
        if (va > vb) return mult;
        return (Number(b.id) || 0) - (Number(a.id) || 0); // desempate estável
    });
}

/**
 * Une as ocorrências: cada RESERVA vira 1 linha (o caso ATUAL = mais recente),
 * com `casos_count` = quantas vezes a reserva passou pela automação. Sem isso,
 * a mesma reserva reprocessada aparecia várias vezes na lista e ficava difícil
 * saber em que pé ela está - o histórico completo continua no modal.
 *
 * Os filtros de escopo (reserva, empreendimento, datas, busca, etapa CV)
 * definem QUAIS reservas entram: qualquer ocorrência que case traz a reserva.
 * Já o filtro de STATUS é avaliado sobre o caso atual - senão uma reserva já
 * resolvida voltava a aparecer ao filtrar "Pendência" por causa de uma
 * tentativa antiga.
 */
async function casosAtuaisPorReserva(query) {
    const { Op } = db.Sequelize;
    const scopeWhere = buildHistoryWhere(query, { skipStatus: true });
    const cvIds = await resolveCvEtapaFilter({ cvSituacao: query.cvSituacao, cvRepasse: query.cvRepasse });
    applyCvIdsToWhere(scopeWhere, cvIds, Op);

    const grupos = await db.ReservaCancelHistory.findAll({
        where: scopeWhere,
        attributes: ['idreserva', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'casos']],
        group: ['idreserva'],
        raw: true,
    });
    if (!grupos.length) return [];
    const casosPorReserva = new Map(grupos.map(g => [Number(g.idreserva), Number(g.casos)]));

    // Caso atual = MAX(id) por reserva SEM o recorte de datas, pra refletir o
    // estado de agora mesmo que a última ocorrência esteja fora do período.
    const atuais = await db.ReservaCancelHistory.findAll({
        where: { idreserva: { [Op.in]: [...casosPorReserva.keys()] } },
        attributes: [[db.Sequelize.fn('MAX', db.Sequelize.col('id')), 'max_id']],
        group: ['idreserva'],
        raw: true,
    });
    const found = await db.ReservaCancelHistory.findAll({
        where: { id: { [Op.in]: atuais.map(a => Number(a.max_id)) } },
    });

    const statusArr = statusArrFromQuery(query);
    return found
        .filter(r => !statusArr || statusArr.includes(r.status))
        .map(r => {
            const j = r.toJSON();
            j.casos_count = casosPorReserva.get(Number(r.idreserva)) || 1;
            return j;
        });
}

export async function listHistory(req, res) {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const sort = sortSpec(req.query);
        // Agrupado por reserva é o padrão da tela; `groupByReserva=false` volta
        // a listar 1 linha por ocorrência.
        const agrupar = String(req.query.groupByReserva ?? 'true') !== 'false';

        let rows;
        let total;
        if (agrupar) {
            const todos = sortRows(await casosAtuaisPorReserva(req.query), sort);
            total = todos.length;
            rows = todos.slice(offset, offset + limit);
        } else {
            const { Op } = db.Sequelize;
            const where = buildHistoryWhere(req.query);
            const cvIds = await resolveCvEtapaFilter({ cvSituacao: req.query.cvSituacao, cvRepasse: req.query.cvRepasse });
            applyCvIdsToWhere(where, cvIds, Op);
            const order = sort.key === 'id'
                ? [['id', sort.dir]]
                : [[sort.key, sort.dir], ['id', 'DESC']];
            const found = await db.ReservaCancelHistory.findAndCountAll({ where, order, limit, offset });
            rows = found.rows.map(r => r.toJSON());
            total = found.count;
        }

        // Etapa ATUAL da reserva e do repasse no CV (lida do banco local).
        const etapas = await fetchCvEtapaByReserva(rows.map(r => r.idreserva));
        for (const r of rows) Object.assign(r, etapas.get(Number(r.idreserva)) || {});

        return res.json({ rows, total, page, limit, grouped: agrupar });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function getHistoryStats(req, res) {
    try {
        const agrupar = String(req.query.groupByReserva ?? 'true') !== 'false';
        const byStatus = {};

        if (agrupar) {
            // KPIs contam RESERVAS (pelo status do caso atual), pra bater com a
            // lista agrupada. Ignora o filtro de status: os chips são o filtro.
            const atuais = await casosAtuaisPorReserva({ ...req.query, status: '' });
            for (const r of atuais) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
            return res.json({ byStatus, grouped: true });
        }

        const { Op } = db.Sequelize;
        const where = buildHistoryWhere({ ...req.query, status: '' });
        const cvIds = await resolveCvEtapaFilter({ cvSituacao: req.query.cvSituacao, cvRepasse: req.query.cvRepasse });
        applyCvIdsToWhere(where, cvIds, Op);
        const rows = await db.ReservaCancelHistory.findAll({
            where,
            attributes: ['status', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
            group: ['status'],
            raw: true,
        });
        for (const r of rows) byStatus[r.status] = Number(r.count);
        return res.json({ byStatus, grouped: false });
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
        // Etapas do CV (reserva e repasse) presentes no histórico, com as cores
        // do workflow - alimenta os filtros de etapa.
        const { cvSituacoes, cvRepasses } = await fetchCvEtapaFacets('reserva_cancel_history');
        return res.json({ empreendimentos, cvSituacoes, cvRepasses });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export async function getHistoryItem(req, res) {
    try {
        const item = await db.ReservaCancelHistory.findByPk(req.params.id);
        if (!item) return res.status(404).json({ error: 'Registro não encontrado.' });
        const etapas = await fetchCvEtapaByReserva([item.idreserva]);
        return res.json({ ...item.toJSON(), ...(etapas.get(Number(item.idreserva)) || {}) });
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
