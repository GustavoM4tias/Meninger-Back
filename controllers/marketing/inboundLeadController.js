// controllers/marketing/inboundLeadController.js
//
// API admin da captação de leads — listagem, detalhe com timeline de eventos,
// inbox de leads "held" (roteamento manual), redispatch, spam e health.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { dispatchLead } from '../../services/marketing/CvLeadDispatchService.js';
import { recordLeadEvent } from '../../services/marketing/leadEventLog.js';

const { InboundLead, InboundLeadEvent } = db;

const LEAD_STATUSES = [
    'received', 'validated', 'spam', 'held', 'routed',
    'dispatching', 'delivered', 'rejected', 'failed',
];

// Lista paginada — exclui os JSONB pesados (vêm só no detalhe).
export async function listInboundLeads(req, res) {
    try {
        const { status, channel, q } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

        const where = {};
        if (status) {
            where.status = { [Op.in]: String(status).split(',').map(s => s.trim()).filter(Boolean) };
        }
        if (channel) where.channel = channel;
        if (q && String(q).trim()) {
            const term = `%${String(q).trim()}%`;
            where[Op.or] = [
                { nome: { [Op.iLike]: term } },
                { email: { [Op.iLike]: term } },
                { telefone: { [Op.iLike]: term } },
            ];
        }

        const { rows, count } = await InboundLead.findAndCountAll({
            where,
            attributes: { exclude: ['raw_payload', 'cv_request_payload', 'cv_response'] },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset: (page - 1) * pageSize,
        });

        return res.json({ ok: true, total: count, page, pageSize, results: rows });
    } catch (err) {
        console.error(`❌ [marketing-capture] listInboundLeads: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao listar leads.' });
    }
}

// Detalhe completo + timeline de eventos.
export async function getInboundLead(req, res) {
    try {
        const lead = await InboundLead.findByPk(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        const events = await InboundLeadEvent.findAll({
            where: { inbound_lead_id: lead.id },
            order: [['id', 'ASC']],
        });
        return res.json({ ok: true, lead, events });
    } catch (err) {
        console.error(`❌ [marketing-capture] getInboundLead: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar o lead.' });
    }
}

// Resolve o vínculo de um lead "held" e o coloca em rota para o CV.
export async function routeInboundLead(req, res) {
    try {
        const lead = await InboundLead.findByPk(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        if (lead.status !== 'held') {
            return res.status(409).json({ ok: false, error: `Só é possível rotear leads em "held" (atual: ${lead.status}).` });
        }

        const { bound_empreendimentos, midia_slug, cv_origem, tags } = req.body || {};
        if (!midia_slug || !cv_origem) {
            return res.status(400).json({ ok: false, error: 'Informe midia_slug e cv_origem.' });
        }

        if (Array.isArray(bound_empreendimentos)) lead.bound_empreendimentos = bound_empreendimentos;
        lead.midia_slug = String(midia_slug).trim();
        lead.cv_origem = String(cv_origem).trim();
        if (Array.isArray(tags)) lead.tags = tags;
        lead.status = 'routed';
        await lead.save();

        await recordLeadEvent({
            leadId: lead.id, type: 'routed',
            statusFrom: 'held', statusTo: 'routed',
            actor: `user:${req.user.id}`,
            message: 'Vínculo resolvido manualmente no inbox.',
            detail: { midia_slug: lead.midia_slug, cv_origem: lead.cv_origem, empreendimentos: lead.bound_empreendimentos },
        });

        dispatchLead(lead, { actor: `user:${req.user.id}` }).catch(err => {
            console.error(`❌ [marketing-capture] despacho pós-roteamento ${lead.id}: ${err.message}`);
        });

        return res.json({ ok: true, lead });
    } catch (err) {
        console.error(`❌ [marketing-capture] routeInboundLead: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao rotear o lead.' });
    }
}

// Redispara manualmente um lead que falhou ou foi recusado.
export async function redispatchInboundLead(req, res) {
    try {
        const lead = await InboundLead.findByPk(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        if (!['failed', 'rejected'].includes(lead.status)) {
            return res.status(409).json({ ok: false, error: `Redispatch só para leads "failed" ou "rejected" (atual: ${lead.status}).` });
        }
        await recordLeadEvent({
            leadId: lead.id, type: 'manual_redispatch',
            actor: `user:${req.user.id}`,
            message: 'Redisparo manual solicitado pelo inbox.',
        });
        const result = await dispatchLead(lead, { actor: `user:${req.user.id}` });
        await lead.reload();
        return res.json({ ok: true, result, lead });
    } catch (err) {
        console.error(`❌ [marketing-capture] redispatchInboundLead: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao redisparar o lead.' });
    }
}

export async function markSpam(req, res) {
    try {
        const lead = await InboundLead.findByPk(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        if (lead.status === 'delivered') {
            return res.status(409).json({ ok: false, error: 'Lead já entregue ao CV não pode virar spam.' });
        }
        const from = lead.status;
        lead.status = 'spam';
        lead.is_spam = true;
        lead.spam_reasons = ['manual'];
        await lead.save();
        await recordLeadEvent({
            leadId: lead.id, type: 'spam_flagged',
            statusFrom: from, statusTo: 'spam',
            actor: `user:${req.user.id}`,
            message: 'Marcado como spam manualmente.',
        });
        return res.json({ ok: true, lead });
    } catch (err) {
        console.error(`❌ [marketing-capture] markSpam: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao marcar spam.' });
    }
}

export async function unmarkSpam(req, res) {
    try {
        const lead = await InboundLead.findByPk(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        if (lead.status !== 'spam') {
            return res.status(409).json({ ok: false, error: 'Lead não está marcado como spam.' });
        }
        lead.status = 'held';
        lead.is_spam = false;
        lead.spam_reasons = null;
        await lead.save();
        await recordLeadEvent({
            leadId: lead.id, type: 'held',
            statusFrom: 'spam', statusTo: 'held',
            actor: `user:${req.user.id}`,
            message: 'Spam desfeito — lead reenviado ao inbox para roteamento.',
        });
        return res.json({ ok: true, lead });
    } catch (err) {
        console.error(`❌ [marketing-capture] unmarkSpam: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao desfazer spam.' });
    }
}

// Painel de saúde da captação — contadores e pendências.
export async function captureHealth(req, res) {
    try {
        const grouped = await InboundLead.findAll({
            attributes: ['status', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
            group: ['status'],
            raw: true,
        });
        const counts = {};
        for (const s of LEAD_STATUSES) counts[s] = 0;
        for (const row of grouped) counts[row.status] = Number(row.count);

        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [deadLetter, failed24h, oldestHeld, oldestFailed] = await Promise.all([
            InboundLead.count({ where: { status: 'failed', next_retry_at: { [Op.is]: null } } }),
            InboundLead.count({ where: { status: 'failed', last_dispatch_at: { [Op.gte]: since } } }),
            InboundLead.findOne({ where: { status: 'held' }, order: [['created_at', 'ASC']] }),
            InboundLead.findOne({ where: { status: 'failed' }, order: [['created_at', 'ASC']] }),
        ]);

        return res.json({
            ok: true,
            dry_run: process.env.MARKETING_CAPTURE_DRY_RUN === 'true',
            counts,
            dead_letter: deadLetter,
            failed_24h: failed24h,
            oldest_held: oldestHeld,
            oldest_failed: oldestFailed,
        });
    } catch (err) {
        console.error(`❌ [marketing-capture] captureHealth: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar o health.' });
    }
}

// Lista enxuta dos empreendimentos do CV CRM, pra alimentar os multiselects
// das telas de Formulários e Captação (vínculo de lead).
export async function listCvEnterprises(req, res) {
    try {
        const { CvEnterprise } = db;
        const rows = await CvEnterprise.findAll({
            attributes: [
                ['idempreendimento', 'id'],
                ['nome', 'name'],
                ['cidade', 'city'],
                ['situacao_comercial_nome', 'status'],
            ],
            order: [['nome', 'ASC']],
            raw: true,
        });
        return res.json({ ok: true, results: rows });
    } catch (err) {
        console.error(`❌ [marketing-capture] listCvEnterprises: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao listar empreendimentos.' });
    }
}

export default {
    listInboundLeads, getInboundLead, routeInboundLead,
    redispatchInboundLead, markSpam, unmarkSpam, captureHealth,
    listCvEnterprises,
};
