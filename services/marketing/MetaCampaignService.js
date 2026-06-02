// services/marketing/MetaCampaignService.js
//
// Sincroniza campanhas Meta (de todas as contas de anúncio acessíveis) + os
// insights de gasto/impressão/clique do período. Cruza com leads do nosso
// banco (agrupados por meta_campaign_id) pra calcular CAC, CTR, etc.

import axios from 'axios';
import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';
import MarketingConfigService from './MarketingConfigService.js';

const { MetaCampaign, InboundLead } = db;

async function getCreds() {
    const cfg = await MarketingConfigService.getConfig({ withSecrets: true, useCache: false });
    const token = cfg.meta_access_token;
    const version = cfg.meta_graph_api_version || 'v21.0';
    if (!token) throw new Error('Token de acesso do Meta não configurado.');
    return { token, version, base: `https://graph.facebook.com/${version}` };
}

/** Lista contas de anúncio acessíveis pelo System User. */
async function listAdAccounts({ token, base }) {
    const all = [];
    let url = `${base}/me/adaccounts`;
    let params = {
        access_token: token,
        fields: 'id,account_id,name,currency,account_status',
        limit: 100,
    };
    for (let i = 0; i < 5; i++) {
        const r = await axios.get(url, { params, timeout: 20000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];
        all.push(...data);
        const next = r.data?.paging?.next;
        if (!next) break;
        url = next; params = {};
    }
    return all;
}

/**
 * Lista campanhas de uma conta com insights agregados do período.
 * fields: campos de campanha + sub-objeto insights com sum no período.
 */
async function listCampaignsForAccount({ token, base }, accountId, { since, until }) {
    const all = [];
    // act_xxx prefix se ainda não tiver
    const acct = accountId.startsWith('act_') ? accountId : `act_${accountId}`;

    let url = `${base}/${acct}/campaigns`;
    let params = {
        access_token: token,
        fields: [
            'id', 'name', 'status', 'effective_status', 'objective', 'buying_type',
            'start_time', 'stop_time', 'updated_time',
            'daily_budget', 'lifetime_budget', 'budget_remaining',
            // insights agregados do período (inclui actions pra contagem de leads)
            `insights.time_range({"since":"${since}","until":"${until}"}).fields(spend,impressions,clicks,reach,cpm,cpc,ctr,actions)`,
        ].join(','),
        limit: 100,
    };

    for (let i = 0; i < 10; i++) {
        const r = await axios.get(url, { params, timeout: 30000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];
        all.push(...data);
        const next = r.data?.paging?.next;
        if (!next) break;
        url = next; params = {};
    }
    return all;
}

function ymd(d) {
    return d.toISOString().slice(0, 10);
}

/**
 * Sincroniza campanhas + insights. Janela default: últimos 90 dias.
 * Retorna { accounts_count, campaigns_total, campaigns_new, campaigns_updated, errors }.
 */
export async function syncFromMeta({ sinceDays = 90, until = new Date() } = {}) {
    const creds = await getCreds();
    const accounts = await listAdAccounts(creds);

    const sinceDate = new Date(until);
    sinceDate.setDate(sinceDate.getDate() - sinceDays);
    const since = ymd(sinceDate);
    const untilStr = ymd(until);

    let campaignsTotal = 0;
    let campaignsNew = 0;
    let campaignsUpdated = 0;
    const errors = [];

    for (const acct of accounts) {
        let campaigns;
        try {
            campaigns = await listCampaignsForAccount(creds, acct.id, { since, until: untilStr });
        } catch (err) {
            const detail = err?.response?.data?.error?.message || err.message;
            errors.push({ account_id: acct.id, account_name: acct.name, error: detail });
            continue;
        }

        for (const c of campaigns) {
            campaignsTotal += 1;
            const ins = (Array.isArray(c.insights?.data) && c.insights.data[0]) || {};

            // Contagem de leads pela Meta — examina actions[]. Os action_types
            // que representam leads (em ordem de preferência): lead, leadgen.other,
            // onsite_conversion.lead_grouped. Pega o primeiro disponível.
            const LEAD_ACTION_TYPES = [
                'lead',
                'onsite_conversion.lead_grouped',
                'leadgen.other',
                'offsite_conversion.fb_pixel_lead',
            ];
            let metaLeadsTotal = 0;
            if (Array.isArray(ins.actions)) {
                for (const t of LEAD_ACTION_TYPES) {
                    const found = ins.actions.find(a => a.action_type === t);
                    if (found && Number(found.value) > 0) {
                        metaLeadsTotal = Number(found.value);
                        break;
                    }
                }
            }

            const payload = {
                id:                 String(c.id),
                account_id:         String(acct.id || ''),
                account_name:       acct.name || null,
                name:               c.name || null,
                status:             c.status || null,
                effective_status:   c.effective_status || null,
                objective:          c.objective || null,
                buying_type:        c.buying_type || null,
                start_time:         c.start_time ? new Date(c.start_time) : null,
                stop_time:          c.stop_time ? new Date(c.stop_time) : null,
                updated_time:       c.updated_time ? new Date(c.updated_time) : null,
                daily_budget_cents:    c.daily_budget    ? Number(c.daily_budget)    : null,
                lifetime_budget_cents: c.lifetime_budget ? Number(c.lifetime_budget) : null,
                budget_remaining_cents: c.budget_remaining ? Number(c.budget_remaining) : null,
                currency:           acct.currency || 'BRL',
                spend:              Number(ins.spend)       || 0,
                impressions:        Number(ins.impressions) || 0,
                clicks:             Number(ins.clicks)      || 0,
                reach:              Number(ins.reach)       || 0,
                cpm:                ins.cpm ? Number(ins.cpm) : null,
                cpc:                ins.cpc ? Number(ins.cpc) : null,
                ctr:                ins.ctr ? Number(ins.ctr) : null,
                meta_leads_total:   metaLeadsTotal,
                last_synced_at:     new Date(),
                last_insights_at:   new Date(),
                insights_since:     since,
                insights_until:     untilStr,
            };

            const existing = await MetaCampaign.findByPk(payload.id);
            if (!existing) {
                await MetaCampaign.create(payload);
                campaignsNew += 1;
            } else {
                // Preserva campos editáveis pelo admin (notes, priority, archived).
                Object.assign(existing, payload);
                await existing.save();
                campaignsUpdated += 1;
            }
        }
    }

    return {
        accounts_count: accounts.length,
        campaigns_total: campaignsTotal,
        campaigns_new: campaignsNew,
        campaigns_updated: campaignsUpdated,
        since, until: untilStr,
        errors,
    };
}

/** Anexa stats agregadas de leads (por meta_campaign_id). */
async function attachLeadStats(rows) {
    if (!rows.length) return rows;
    const ids = rows.map(r => r.id);

    const stats = await InboundLead.findAll({
        where: { meta_campaign_id: { [Op.in]: ids } },
        attributes: [
            ['meta_campaign_id', 'meta_campaign_id'],
            [fn('COUNT', col('id')), 'total'],
            [fn('SUM', literal(`CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END`)), 'last_30d'],
            [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN 1 ELSE 0 END`)), 'delivered'],
            [fn('SUM', literal(`CASE WHEN status = 'held'      THEN 1 ELSE 0 END`)), 'held'],
            [fn('SUM', literal(`CASE WHEN status = 'spam'      THEN 1 ELSE 0 END`)), 'spam'],
            [fn('MAX', col('created_at')), 'last_lead_at'],
        ],
        group: ['meta_campaign_id'],
        raw: true,
    });

    const byId = new Map();
    for (const s of stats) {
        byId.set(String(s.meta_campaign_id), {
            total:        Number(s.total)     || 0,
            last_30d:     Number(s.last_30d)  || 0,
            delivered:    Number(s.delivered) || 0,
            held:         Number(s.held)      || 0,
            spam:         Number(s.spam)      || 0,
            last_lead_at: s.last_lead_at || null,
        });
    }

    return rows.map(r => {
        const plain = r.get ? r.get({ plain: true }) : r;
        const lead_stats = byId.get(String(plain.id)) || {
            total: 0, last_30d: 0, delivered: 0, held: 0, spam: 0, last_lead_at: null,
        };
        const spend = Number(plain.spend) || 0;
        const metaLeads = Number(plain.meta_leads_total) || 0;

        // CAC preferido: usa nossa contagem se temos leads no banco; senão usa
        // a contagem da Meta (cobre histórico que não passou pelo webhook).
        const effectiveLeads = lead_stats.total > 0 ? lead_stats.total : metaLeads;
        const cac = effectiveLeads > 0 ? +(spend / effectiveLeads).toFixed(2) : null;
        const cac_source = lead_stats.total > 0 ? 'office' : (metaLeads > 0 ? 'meta' : null);

        return { ...plain, lead_stats, meta_leads_total: metaLeads, cac, cac_source };
    });
}

/** Lista todas as campanhas (com stats e CAC). Suporta filtro archived. */
export async function getAll({ includeArchived = false } = {}) {
    const where = {};
    if (!includeArchived) where.archived = false;
    const rows = await MetaCampaign.findAll({
        where,
        order: [['start_time', 'DESC'], ['name', 'ASC']],
    });
    return attachLeadStats(rows);
}

/** Detalhe de uma campanha (com stats + leads recentes). */
export async function getById(campaignId) {
    const row = await MetaCampaign.findByPk(String(campaignId));
    if (!row) return null;
    const [withStats] = await attachLeadStats([row]);
    return { ...withStats, ...computeExecutiveMetrics(withStats) };
}

/**
 * Métricas executivas: pacing, dias, projeção. Calculadas em cima dos campos
 * que já vêm da Meta (start_time, stop_time, spend, daily_budget_cents).
 *
 * Retorna:
 *   days_running          — dias desde start_time até hoje (max 1)
 *   days_total            — dias totais previstos (start → stop), null se sem stop
 *   days_remaining        — dias restantes até stop_time, null se sem stop
 *   daily_avg_spend       — média de gasto diário no período rodado
 *   daily_budget          — orçamento diário em R$ (de daily_budget_cents)
 *   lifetime_budget       — orçamento total previsto
 *   budget_consumed_pct   — % do lifetime já gasto (null se sem lifetime)
 *   projected_total_spend — projeção até stop_time (média × dias_total)
 *   spend_pace            — 'on_track' | 'fast' | 'slow' | null
 */
function computeExecutiveMetrics(c) {
    if (!c) return {};
    const now = new Date();
    const start = c.start_time ? new Date(c.start_time) : null;
    const stop  = c.stop_time  ? new Date(c.stop_time)  : null;

    const msDay = 24 * 60 * 60 * 1000;
    const daysRunning = start
        ? Math.max(1, Math.floor((Math.min(now.getTime(), stop?.getTime() || now.getTime()) - start.getTime()) / msDay))
        : null;
    const daysTotal     = (start && stop) ? Math.max(1, Math.ceil((stop.getTime() - start.getTime()) / msDay)) : null;
    const daysRemaining = stop ? Math.max(0, Math.ceil((stop.getTime() - now.getTime()) / msDay)) : null;

    const spend = Number(c.spend) || 0;
    const dailyAvgSpend = daysRunning ? +(spend / daysRunning).toFixed(2) : null;

    const dailyBudget    = c.daily_budget_cents    ? Number(c.daily_budget_cents) / 100    : null;
    const lifetimeBudget = c.lifetime_budget_cents ? Number(c.lifetime_budget_cents) / 100 : null;

    const budgetConsumedPct = (lifetimeBudget && lifetimeBudget > 0)
        ? +((spend / lifetimeBudget) * 100).toFixed(1)
        : null;

    // Projeção: se tem stop, projeta gastando média atual até o fim.
    const projectedTotalSpend = (daysTotal && dailyAvgSpend != null)
        ? +(dailyAvgSpend * daysTotal).toFixed(2)
        : null;

    // Pace vs budget diário: rodando mais ou menos que o esperado?
    let spendPace = null;
    if (dailyBudget && dailyAvgSpend != null) {
        const ratio = dailyAvgSpend / dailyBudget;
        if (ratio < 0.7)      spendPace = 'slow';     // gastou <70% do diário
        else if (ratio > 1.3) spendPace = 'fast';     // gastou >130% do diário
        else                  spendPace = 'on_track';
    }

    return {
        days_running:        daysRunning,
        days_total:          daysTotal,
        days_remaining:      daysRemaining,
        daily_avg_spend:     dailyAvgSpend,
        daily_budget:        dailyBudget,
        lifetime_budget:     lifetimeBudget,
        budget_consumed_pct: budgetConsumedPct,
        projected_total_spend: projectedTotalSpend,
        spend_pace:          spendPace,
    };
}

/** Leads dessa campanha (Meta). */
export async function listCampaignLeads(campaignId, { limit = 50 } = {}) {
    const leads = await InboundLead.findAll({
        where: { meta_campaign_id: String(campaignId) },
        attributes: [
            'id', 'nome', 'email', 'telefone', 'channel', 'status',
            'midia_slug', 'cv_origem', 'meta_form_id', 'meta_ad_id',
            'is_spam', 'created_at',
        ],
        order: [['created_at', 'DESC']],
        limit,
    });
    return leads.map(l => l.get({ plain: true }));
}

/**
 * Breakdown diário com:
 *  - Gasto / impressões / cliques / leads-Meta vindos de insights diários da Meta
 *  - Contagem de leads no nosso DB
 *
 * Faz 1 chamada de insights na Meta + 1 query no DB. Resultado: array de
 * { day, spend, impressions, clicks, meta_leads, office_leads, delivered }.
 */
export async function getDailyBreakdown(campaignId, { days = 30 } = {}) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);
    const untilStr = new Date().toISOString().slice(0, 10);

    // ── Insights diários da Meta ────────────────────────────────────────────
    const byDay = new Map();
    try {
        const creds = await getCreds();
        const url = `${creds.base}/${encodeURIComponent(campaignId)}/insights`;
        const params = {
            access_token: creds.token,
            fields: 'spend,impressions,clicks,actions,date_start',
            time_increment: 1,
            time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
            limit: 1000,
        };
        const r = await axios.get(url, { params, timeout: 30000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];

        const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'leadgen.other'];
        for (const row of data) {
            const day = row.date_start;
            let metaLeads = 0;
            if (Array.isArray(row.actions)) {
                for (const t of LEAD_TYPES) {
                    const a = row.actions.find(x => x.action_type === t);
                    if (a && Number(a.value) > 0) { metaLeads = Number(a.value); break; }
                }
            }
            byDay.set(day, {
                day,
                spend: Number(row.spend) || 0,
                impressions: Number(row.impressions) || 0,
                clicks: Number(row.clicks) || 0,
                meta_leads: metaLeads,
                office_leads: 0,
                delivered: 0,
            });
        }
    } catch (err) {
        // Se a Meta falhar, segue sem spend (não bloqueia leads do nosso DB).
        console.warn(`[meta-campaigns] daily insights falhou pra ${campaignId}: ${err?.response?.data?.error?.message || err.message}`);
    }

    // ── Leads do nosso DB por dia ───────────────────────────────────────────
    const officeRows = await InboundLead.findAll({
        where: {
            meta_campaign_id: String(campaignId),
            created_at: { [Op.gte]: since },
        },
        attributes: [
            [fn('DATE', col('created_at')), 'day'],
            [fn('COUNT', col('id')), 'count'],
            [fn('SUM', literal(`CASE WHEN status='delivered' THEN 1 ELSE 0 END`)), 'delivered'],
        ],
        group: [fn('DATE', col('created_at'))],
        order: [[fn('DATE', col('created_at')), 'ASC']],
        raw: true,
    });

    for (const r of officeRows) {
        const day = String(r.day).slice(0, 10);
        const existing = byDay.get(day) || {
            day, spend: 0, impressions: 0, clicks: 0, meta_leads: 0, office_leads: 0, delivered: 0,
        };
        existing.office_leads = Number(r.count) || 0;
        existing.delivered = Number(r.delivered) || 0;
        byDay.set(day, existing);
    }

    // Retorna ordenado por dia ascendente.
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Atualiza campos editáveis pelo admin (notes, priority, archived). */
export async function updateInternal(campaignId, patch = {}) {
    const row = await MetaCampaign.findByPk(String(campaignId));
    if (!row) throw new Error('Campanha não encontrada.');
    const allowed = [
        // Gestão
        'notes', 'priority', 'archived',
        // Vínculo CV
        'bound_empreendimentos', 'midia_slug', 'cv_origem', 'tags', 'mapping_active',
        // UTMs default
        'default_utm_source', 'default_utm_medium', 'default_utm_campaign',
        'default_utm_content', 'default_utm_term',
        // Extras
        'cv_extra_fields',
    ];
    for (const k of allowed) if (patch[k] !== undefined) row[k] = patch[k];
    await row.save();
    return row.get({ plain: true });
}

/**
 * Migra mappings de form pra campanha. Pra cada form com mapping, copia o
 * vínculo pra TODAS as campanhas que rodam ads com esse form.
 *
 * Idempotente: só preenche campos que estão null na campanha atual.
 */
export async function migrateFormMappingsToCampaigns() {
    const { MetaLeadForm, MetaAd } = db;

    // Pega forms com mapping configurado (midia_slug preenchido).
    const forms = await MetaLeadForm.findAll({
        where: { midia_slug: { [Op.ne]: null } },
    });

    let formsProcessed = 0;
    let campaignsUpdated = 0;
    const details = [];

    for (const form of forms) {
        formsProcessed += 1;

        // Quais campanhas usam esse form?
        const ads = await MetaAd.findAll({
            where: { lead_form_id: form.id },
            attributes: ['campaign_id'],
            group: ['campaign_id'],
            raw: true,
        });
        const campaignIds = [...new Set(ads.map(a => a.campaign_id).filter(Boolean))];

        for (const campaignId of campaignIds) {
            const camp = await MetaCampaign.findByPk(String(campaignId));
            if (!camp) continue;

            // Só preenche campos que estão null na campanha (não sobrescreve).
            const patch = {};
            const tryCopy = (col) => {
                if (camp[col] == null && form[col] != null) patch[col] = form[col];
            };
            tryCopy('bound_empreendimentos');
            tryCopy('midia_slug');
            tryCopy('cv_origem');
            tryCopy('tags');
            tryCopy('default_utm_source');
            tryCopy('default_utm_medium');
            tryCopy('default_utm_campaign');
            tryCopy('default_utm_content');
            tryCopy('default_utm_term');
            tryCopy('cv_extra_fields');

            // mapping_active só se nunca foi tocado na campanha (mantém default true)
            if (camp.mapping_active == null && form.mapping_active != null) {
                patch.mapping_active = form.mapping_active;
            }

            if (Object.keys(patch).length > 0) {
                Object.assign(camp, patch);
                await camp.save();
                campaignsUpdated += 1;
                details.push({ form_id: form.id, form_name: form.name, campaign_id: campaignId, fields: Object.keys(patch) });
            }
        }
    }

    return { forms_processed: formsProcessed, campaigns_updated: campaignsUpdated, details };
}

export default {
    syncFromMeta, getAll, getById, listCampaignLeads, getDailyBreakdown, updateInternal,
    migrateFormMappingsToCampaigns,
};
