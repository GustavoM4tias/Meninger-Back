// controllers/marketing/inboundLeadController.js
//
// API admin da captação de leads — listagem, detalhe com timeline de eventos,
// inbox de leads "held" (roteamento manual), redispatch, spam e health.

import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { dispatchLead } from '../../services/marketing/CvLeadDispatchService.js';
import { recordLeadEvent } from '../../services/marketing/leadEventLog.js';
import CvReconciliationService from '../../services/marketing/CvReconciliationService.js';
import LeadCampaignBackfillService from '../../services/marketing/LeadCampaignBackfillService.js';

const { InboundLead, InboundLeadEvent } = db;

const LEAD_STATUSES = [
    'received', 'validated', 'spam', 'held', 'routed',
    'dispatching', 'delivered', 'rejected', 'failed', 'historical',
];

// Janelas suportadas pelo health (em horas). 0 = sem corte (tudo).
const HEALTH_PERIODS = { '24h': 24, '7d': 168, '30d': 720, 'all': 0 };

// Lista paginada com enriquecimento (nome de campanha/form/page + data de entrada
// na Meta extraída do raw_payload via literal SQL).
export async function listInboundLeads(req, res) {
    try {
        const { status, channel, q, cv_origem, midia_slug, meta_campaign_id,
                period_start, period_end } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

        const where = {};
        if (status) {
            where.status = { [Op.in]: String(status).split(',').map(s => s.trim()).filter(Boolean) };
        }
        if (channel) {
            where.channel = { [Op.in]: String(channel).split(',').map(s => s.trim()).filter(Boolean) };
        }
        if (cv_origem) {
            where.cv_origem = { [Op.in]: String(cv_origem).split(',').map(s => s.trim()).filter(Boolean) };
        }
        if (midia_slug) {
            where.midia_slug = { [Op.in]: String(midia_slug).split(',').map(s => s.trim()).filter(Boolean) };
        }
        if (meta_campaign_id) {
            where.meta_campaign_id = { [Op.in]: String(meta_campaign_id).split(',').map(s => s.trim()).filter(Boolean) };
        }
        if (period_start || period_end) {
            where.created_at = {};
            if (period_start) where.created_at[Op.gte] = new Date(period_start);
            if (period_end) {
                const end = new Date(period_end);
                end.setHours(23, 59, 59, 999);
                where.created_at[Op.lte] = end;
            }
        }
        if (q && String(q).trim()) {
            const term = `%${String(q).trim()}%`;
            where[Op.or] = [
                { nome: { [Op.iLike]: term } },
                { email: { [Op.iLike]: term } },
                { telefone: { [Op.iLike]: term } },
                { midia_slug: { [Op.iLike]: term } },
            ];
        }

        // Atributos: exclui JSONB pesados, mas extrai `meta_created_at` via literal
        // SQL (PostgreSQL JSONB path operator) — sem precisar baixar raw_payload.
        const { rows, count } = await InboundLead.findAndCountAll({
            where,
            attributes: {
                exclude: ['raw_payload', 'cv_request_payload', 'cv_response'],
                include: [
                    [literal(`raw_payload#>>'{graph,created_time}'`), 'meta_created_at'],
                    [literal(`raw_payload#>>'{graph,is_organic}'`), 'meta_is_organic'],
                ],
            },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset: (page - 1) * pageSize,
        });

        // Enriquecimento em batch: nome de campanha / form Meta / página / form interno.
        // Uma query por entidade pra paginação não disparar N+1.
        const plain = rows.map(r => r.get({ plain: true }));
        const campaignIds = [...new Set(plain.map(l => l.meta_campaign_id).filter(Boolean))];
        const metaFormIds = [...new Set(plain.map(l => l.meta_form_id).filter(Boolean))];
        const leadFormIds = [...new Set(plain.map(l => l.source_form_id).filter(Boolean))];

        const [campaigns, metaForms, leadForms] = await Promise.all([
            campaignIds.length && db.MetaCampaign
                ? db.MetaCampaign.findAll({
                    where: { id: { [Op.in]: campaignIds } },
                    attributes: ['id', 'name', 'account_name', 'objective'],
                    raw: true,
                })
                : [],
            metaFormIds.length && db.MetaLeadForm
                ? db.MetaLeadForm.findAll({
                    where: { id: { [Op.in]: metaFormIds } },
                    attributes: ['id', 'name', 'page_name'],
                    raw: true,
                })
                : [],
            leadFormIds.length && db.LeadForm
                ? db.LeadForm.findAll({
                    where: { id: { [Op.in]: leadFormIds } },
                    attributes: ['id', 'name', 'slug'],
                    raw: true,
                })
                : [],
        ]);

        const campIx = new Map(campaigns.map(c => [String(c.id), c]));
        const metaFormIx = new Map(metaForms.map(f => [String(f.id), f]));
        const leadFormIx = new Map(leadForms.map(f => [String(f.id), f]));

        const enriched = plain.map(l => {
            const camp = l.meta_campaign_id ? campIx.get(String(l.meta_campaign_id)) : null;
            const mf = l.meta_form_id ? metaFormIx.get(String(l.meta_form_id)) : null;
            const lf = l.source_form_id ? leadFormIx.get(String(l.source_form_id)) : null;
            // cv_delivered_at: proxy = last_dispatch_at quando status='delivered'
            const cv_delivered_at = l.status === 'delivered' ? l.last_dispatch_at : null;
            return {
                ...l,
                meta_campaign_name: camp?.name || null,
                meta_account_name: camp?.account_name || null,
                meta_campaign_objective: camp?.objective || null,
                meta_form_name: mf?.name || null,
                meta_page_name: mf?.page_name || null,
                lead_form_name: lf?.name || null,
                lead_form_slug: lf?.slug || null,
                cv_delivered_at,
            };
        });

        return res.json({ ok: true, total: count, page, pageSize, results: enriched });
    } catch (err) {
        console.error(`❌ [marketing-capture] listInboundLeads: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao listar leads.' });
    }
}

// Detalhe completo + timeline de eventos + info do form Meta (se aplicável) +
// metadados de campanha. Acrescenta meta_created_at e cv_delivered_at no objeto.
export async function getInboundLead(req, res) {
    try {
        const lead = await InboundLead.findByPk(req.params.id);
        if (!lead) return res.status(404).json({ ok: false, error: 'Lead não encontrado.' });
        const events = await InboundLeadEvent.findAll({
            where: { inbound_lead_id: lead.id },
            order: [['id', 'ASC']],
        });

        let meta_form = null;
        let lead_form = null;
        let meta_campaign = null;
        if (lead.meta_form_id && db.MetaLeadForm) {
            const f = await db.MetaLeadForm.findByPk(lead.meta_form_id, {
                attributes: ['id', 'name', 'page_name', 'status', 'created_time', 'questions'],
            });
            if (f) meta_form = f.get({ plain: true });
        }
        if (lead.source_form_id && db.LeadForm) {
            const f = await db.LeadForm.findByPk(lead.source_form_id, {
                attributes: ['id', 'slug', 'name', 'fields_config', 'midia_slug'],
            });
            if (f) lead_form = f.get({ plain: true });
        }
        if (lead.meta_campaign_id && db.MetaCampaign) {
            const c = await db.MetaCampaign.findByPk(lead.meta_campaign_id, {
                attributes: ['id', 'name', 'account_name', 'objective', 'status', 'effective_status', 'midia_slug', 'mapping_active'],
            });
            if (c) meta_campaign = c.get({ plain: true });
        }

        // Datas derivadas pra UI: Meta (raw_payload.graph.created_time), CV (entrega).
        const rp = lead.raw_payload && typeof lead.raw_payload === 'object' ? lead.raw_payload : null;
        const meta_created_at = rp?.graph?.created_time || null;
        const meta_is_organic = rp?.graph?.is_organic === true;
        const cv_delivered_at = lead.status === 'delivered' ? lead.last_dispatch_at : null;

        const leadPlain = { ...lead.get({ plain: true }), meta_created_at, meta_is_organic, cv_delivered_at };

        return res.json({ ok: true, lead: leadPlain, events, meta_form, lead_form, meta_campaign });
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

// Painel de saúde + KPIs agregados por período (?period=24h|7d|30d|all).
// Devolve contadores globais e, separadamente, os agregados do período pra
// alimentar os KPIs/visualizações da tela de captação.
export async function captureHealth(req, res) {
    try {
        const period = String(req.query.period || '7d').toLowerCase();
        const hours = HEALTH_PERIODS[period] ?? HEALTH_PERIODS['7d'];

        // ── Contadores GLOBAIS (toda a base — alimentam dead-letter, oldest_held)
        const grouped = await InboundLead.findAll({
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            group: ['status'],
            raw: true,
        });
        const counts = {};
        for (const s of LEAD_STATUSES) counts[s] = 0;
        for (const row of grouped) counts[row.status] = Number(row.count);

        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [deadLetter, failed24h, oldestHeld, oldestFailed] = await Promise.all([
            InboundLead.count({ where: { status: 'failed', next_retry_at: { [Op.is]: null } } }),
            InboundLead.count({ where: { status: 'failed', last_dispatch_at: { [Op.gte]: since24h } } }),
            InboundLead.findOne({ where: { status: 'held' }, order: [['created_at', 'ASC']] }),
            InboundLead.findOne({ where: { status: 'failed' }, order: [['created_at', 'ASC']] }),
        ]);

        // ── Período: KPIs do recorte selecionado ─────────────────────────────────
        const periodWhere = hours > 0
            ? { created_at: { [Op.gte]: new Date(Date.now() - hours * 60 * 60 * 1000) } }
            : {};

        const periodGrouped = await InboundLead.findAll({
            where: periodWhere,
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            group: ['status'],
            raw: true,
        });
        const period_counts = {};
        for (const s of LEAD_STATUSES) period_counts[s] = 0;
        for (const row of periodGrouped) period_counts[row.status] = Number(row.count);
        const period_total = Object.values(period_counts).reduce((a, b) => a + b, 0);

        const periodChannel = await InboundLead.findAll({
            where: periodWhere,
            attributes: ['channel', [fn('COUNT', col('id')), 'count']],
            group: ['channel'],
            raw: true,
        });
        const by_channel = {};
        for (const row of periodChannel) by_channel[row.channel || 'unknown'] = Number(row.count);

        const periodOrigem = await InboundLead.findAll({
            where: periodWhere,
            attributes: ['cv_origem', [fn('COUNT', col('id')), 'count']],
            group: ['cv_origem'],
            raw: true,
        });
        const by_cv_origem = {};
        for (const row of periodOrigem) by_cv_origem[row.cv_origem || 'unset'] = Number(row.count);

        // Latência média de despacho (segundos): só nos delivered do período.
        // Usa Postgres EXTRACT (EPOCH FROM) — backend é Postgres por todo o resto.
        const latencyRow = await InboundLead.findOne({
            where: { ...periodWhere, status: 'delivered', last_dispatch_at: { [Op.ne]: null } },
            attributes: [
                [fn('AVG', literal('EXTRACT(EPOCH FROM (last_dispatch_at - created_at))')), 'avg_seconds'],
                [fn('MAX', literal('EXTRACT(EPOCH FROM (last_dispatch_at - created_at))')), 'max_seconds'],
            ],
            raw: true,
        });
        const avg_dispatch_seconds = latencyRow?.avg_seconds ? Number(latencyRow.avg_seconds) : null;
        const max_dispatch_seconds = latencyRow?.max_seconds ? Number(latencyRow.max_seconds) : null;

        // Taxa de entrega: delivered / (delivered + held + failed + rejected)
        const deliveryBase = period_counts.delivered + period_counts.held +
                             period_counts.failed + period_counts.rejected;
        const delivery_rate = deliveryBase > 0
            ? Number((period_counts.delivered / deliveryBase * 100).toFixed(1))
            : null;

        return res.json({
            ok: true,
            dry_run: process.env.MARKETING_CAPTURE_DRY_RUN === 'true',
            period,
            counts,                  // global
            dead_letter: deadLetter,
            failed_24h: failed24h,
            oldest_held: oldestHeld,
            oldest_failed: oldestFailed,
            // recorte:
            period_counts,
            period_total,
            by_channel,
            by_cv_origem,
            avg_dispatch_seconds,
            max_dispatch_seconds,
            delivery_rate,
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

/**
 * Backfill de meta_campaign_id pra leads que têm meta_ad_id mas perderam o
 * campaign_id (caso comum em históricos). Delega para LeadCampaignBackfillService.
 *
 * Body opcional: { limit?: number, dryRun?: boolean }
 */
export async function backfillCampaignFromAd(req, res) {
    try {
        const result = await LeadCampaignBackfillService.backfillCampaignsFromAds({
            limit: parseInt(req.body?.limit, 10) || 1000,
            dryRun: req.body?.dryRun === true,
        });
        return res.json({
            ok: true,
            ...result,
            note: result.unresolved > 0
                ? 'Leads não resolvidos têm ad_id de anúncios não sincronizados no cache local. Rode o sync de Ads das campanhas conhecidas e tente novamente.'
                : null,
        });
    } catch (err) {
        console.error(`❌ [marketing-capture] backfillCampaignFromAd: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Tenta achar esse lead no CV via email/telefone e gravar o cv_idlead. */
export async function reconcileWithCv(req, res) {
    try {
        const result = await CvReconciliationService.reconcileLead(req.params.id);
        if (result.matched) {
            // Registra evento (sem mudar status — lead histórico continua como histórico).
            await recordLeadEvent({
                leadId: req.params.id, type: 'cv_reconciled',
                statusFrom: null, statusTo: null,
                message: `Reconciliado com CV via ${result.via} (cv_idlead=${result.cv_idlead}).`,
                detail: result,
            });
        }
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [marketing-capture] reconcileWithCv: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

export default {
    listInboundLeads, getInboundLead, routeInboundLead,
    redispatchInboundLead, markSpam, unmarkSpam, captureHealth,
    listCvEnterprises, reconcileWithCv, backfillCampaignFromAd,
};
