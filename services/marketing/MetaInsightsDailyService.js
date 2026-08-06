// services/marketing/MetaInsightsDailyService.js
//
// Série DIÁRIA de insights Meta (meta_insights_daily) — a régua de tempo dos
// relatórios. Duas responsabilidades:
//
//   syncDaily()  — puxa insights com time_increment=1 por conta+nível
//                  (campaign/adset/ad) e regrava a janela (delete+insert).
//                  1 chamada paginada por conta+nível, não por entidade.
//
//   getReport()  — responde o relatório de um período somando os dias
//                  localmente: linhas por entidade no nível pedido, série
//                  diária do escopo, totais e totais do período ANTERIOR
//                  (mesma duração) pros deltas dos KPIs.
//
// FONTE DE LEAD (2026-08-06): o relatório conta LEAD DA NOSSA BASE
// (inbound_leads — gente com nome/telefone/e-mail), não a contagem da Meta.
// A Meta reporta também leads de pixel, que são só um inteiro agregado, sem
// identificação e sem como cruzar com o CV. Por isso `office_leads` é o número
// de leads da tela e o CAC é gasto ÷ leads da base (cac_source: 'office').
// As métricas de mídia (gasto/impressões/cliques/CTR/CPM/CPC) seguem da Meta.
//
// Métricas derivadas (CTR/CPM/CPC/CAC) são SEMPRE recalculadas das somas —
// nunca médias de médias. Reach não é somado entre dias (não-aditivo).

import axios from 'axios';
import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { getCreds, listAdAccounts } from './MetaCampaignService.js';
import { extractLeadBreakdown } from './metaLeadExtract.js';
import { LEAD_DAY_SQL, LEAD_DAY_TEXT_SQL } from './leadDaySql.js';

const { MetaInsightDaily, MetaCampaign, MetaAdSet, MetaAd, InboundLead, sequelize } = db;

const LEVELS = ['campaign', 'adset', 'ad'];

function ymd(d) { return d.toISOString().slice(0, 10); }

// Campos de insights por nível — pedir ad_id em level=campaign é erro na Graph.
const FIELDS_BY_LEVEL = {
    campaign: 'campaign_id,spend,impressions,clicks,reach,actions',
    adset:    'campaign_id,adset_id,spend,impressions,clicks,reach,actions',
    ad:       'campaign_id,adset_id,ad_id,spend,impressions,clicks,reach,actions',
};

const ENTITY_ID_FIELD = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };

/**
 * Sincroniza a série diária. Por conta+nível: 1 GET paginado em
 * /act_x/insights (level, time_increment=1, time_range) e regrava a janela
 * inteira numa transação (idempotente; re-rodar corrige dias retroativos —
 * a Meta ajusta números de até ~28 dias pra trás).
 */
export async function syncDaily({ sinceDays = 3, until = new Date(), levels = ['campaign'] } = {}) {
    const creds = await getCreds();
    const accounts = await listAdAccounts(creds);

    const sinceDate = new Date(until);
    sinceDate.setDate(sinceDate.getDate() - sinceDays);
    const since = ymd(sinceDate);
    const untilStr = ymd(until);

    const wanted = levels.filter(l => LEVELS.includes(l));
    let rowsWritten = 0;
    const errors = [];

    for (const acct of accounts) {
        for (const level of wanted) {
            try {
                const records = [];
                let url = `${creds.base}/${acct.id}/insights`;
                let params = {
                    access_token: creds.token,
                    level,
                    time_increment: 1,
                    time_range: JSON.stringify({ since, until: untilStr }),
                    fields: FIELDS_BY_LEVEL[level],
                    limit: 500,
                };

                // Até 60 páginas (30k linhas) por conta+nível — acima disso loga e corta.
                let truncated = false;
                for (let page = 0; page < 60; page++) {
                    const r = await axios.get(url, { params, timeout: 60000 });
                    const data = Array.isArray(r.data?.data) ? r.data.data : [];
                    for (const row of data) {
                        const entityId = row[ENTITY_ID_FIELD[level]];
                        if (!entityId || !row.date_start) continue;
                        const bd = extractLeadBreakdown(row.actions);
                        records.push({
                            entity_level: level,
                            entity_id:    String(entityId),
                            date:         row.date_start,
                            account_id:   String(acct.id),
                            campaign_id:  row.campaign_id ? String(row.campaign_id) : null,
                            adset_id:     row.adset_id ? String(row.adset_id) : null,
                            spend:        Number(row.spend) || 0,
                            impressions:  Number(row.impressions) || 0,
                            clicks:       Number(row.clicks) || 0,
                            reach:        Number(row.reach) || 0,
                            meta_leads:       bd.total,
                            meta_leads_form:  bd.form,
                            meta_leads_pixel: bd.pixel,
                        });
                    }
                    const next = r.data?.paging?.next;
                    if (!next) break;
                    if (page === 59) truncated = true;
                    url = next; params = {};
                }
                if (truncated) {
                    console.warn(`⚠️  [insights-daily] ${acct.id}/${level}: 60 páginas atingidas — janela truncada. Reduza sinceDays.`);
                }

                // Regrava a janela da conta+nível atomicamente. bulkCreate em
                // lotes de 500 pra não montar um INSERT gigante (memória/DB) —
                // nível de anúncio em janelas longas gera muitos registros.
                await sequelize.transaction(async (t) => {
                    await MetaInsightDaily.destroy({
                        where: {
                            entity_level: level,
                            account_id: String(acct.id),
                            date: { [Op.between]: [since, untilStr] },
                        },
                        transaction: t,
                    });
                    for (let i = 0; i < records.length; i += 500) {
                        await MetaInsightDaily.bulkCreate(records.slice(i, i + 500), { transaction: t });
                    }
                });
                rowsWritten += records.length;
            } catch (err) {
                const detail = err?.response?.data?.error?.message || err.message;
                errors.push({ account_id: acct.id, account_name: acct.name, level, error: detail });
                console.warn(`⚠️  [insights-daily] ${acct.name || acct.id}/${level}: ${detail}`);
            }
        }
    }

    return {
        accounts_count: accounts.length,
        levels: wanted,
        rows_written: rowsWritten,
        since, until: untilStr,
        errors,
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Relatório por período
// ────────────────────────────────────────────────────────────────────────────

function buildWhere({ level, since, until, accountIds, campaignId, adsetId }) {
    const where = {
        entity_level: level,
        date: { [Op.between]: [since, until] },
    };
    if (accountIds?.length) where.account_id = { [Op.in]: accountIds };
    if (campaignId) where.campaign_id = String(campaignId);
    if (adsetId)    where.adset_id    = String(adsetId);
    return where;
}

const SUM_ATTRS = [
    [fn('SUM', col('spend')),       'spend'],
    [fn('SUM', col('impressions')), 'impressions'],
    [fn('SUM', col('clicks')),      'clicks'],
];

/**
 * Deriva CTR/CPM/CPC/CAC a partir das somas do período.
 * `officeLeads` = leads da NOSSA base atribuídos ao escopo (ver officeLeadStats).
 */
function derive(m, officeLeads = 0, officeDelivered = 0) {
    const spend = Number(m.spend) || 0;
    const impressions = Number(m.impressions) || 0;
    const clicks = Number(m.clicks) || 0;
    const leads = Number(officeLeads) || 0;
    return {
        spend: +spend.toFixed(2),
        impressions, clicks,
        office_leads: leads,
        office_leads_delivered: Number(officeDelivered) || 0,
        ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(4) : null,
        cpm: impressions > 0 ? +((spend / impressions) * 1000).toFixed(2) : null,
        cpc: clicks > 0 ? +(spend / clicks).toFixed(2) : null,
        // CAC sobre lead que existe na base — não sobre a contagem da Meta.
        cac: leads > 0 ? +(spend / leads).toFixed(2) : null,
        cac_source: 'office',
    };
}

// ── Leads da nossa base (inbound_leads) ─────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Recorta o escopo de leads a partir do mesmo `where` dos insights.
 * A nossa base não guarda adset_id no lead — no drill por conjunto o recorte
 * é feito pelos anúncios do conjunto (meta_ad_id vem do webhook de Lead Ads).
 */
async function leadScope(where, adsetId) {
    const camps = await MetaInsightDaily.findAll({
        where, attributes: ['campaign_id'], group: ['campaign_id'], raw: true,
    });
    const campaignIds = camps.map(c => c.campaign_id).filter(Boolean).map(String);
    if (!adsetId) return { campaignIds, adIds: null };

    const ads = await MetaAd.findAll({
        where: { adset_id: String(adsetId) }, attributes: ['id'], raw: true,
    });
    return { campaignIds, adIds: ads.map(a => String(a.id)) };
}

/**
 * Contagem de leads da base por (campanha, anúncio, dia) no período/escopo.
 * Spam fica de fora — é lead sem valor comercial e distorceria o CAC pra baixo.
 *
 * @returns {{ rows: Array, total: number, delivered: number }}
 */
async function officeLeadStats({ since, until, campaignIds, adIds }) {
    const empty = { rows: [], total: 0, delivered: 0 };
    if (!campaignIds?.length) return empty;
    if (adIds && !adIds.length) return empty;

    const where = {
        meta_campaign_id: { [Op.in]: campaignIds },
        is_spam: false,
        status: { [Op.ne]: 'spam' },
        [Op.and]: [literal(`${LEAD_DAY_SQL} BETWEEN '${since}' AND '${until}'`)],
    };
    if (adIds) where.meta_ad_id = { [Op.in]: adIds };

    const raw = await InboundLead.findAll({
        where,
        attributes: [
            'meta_campaign_id',
            'meta_ad_id',
            [literal(LEAD_DAY_TEXT_SQL), 'day'],
            [fn('COUNT', col('id')), 'total'],
            [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN 1 ELSE 0 END`)), 'delivered'],
        ],
        group: ['meta_campaign_id', 'meta_ad_id', literal(LEAD_DAY_SQL)],
        raw: true,
    });

    const rows = raw.map(r => ({
        campaign_id: r.meta_campaign_id ? String(r.meta_campaign_id) : null,
        ad_id:       r.meta_ad_id ? String(r.meta_ad_id) : null,
        day:         String(r.day).slice(0, 10),
        total:       Number(r.total) || 0,
        delivered:   Number(r.delivered) || 0,
    }));

    return {
        rows,
        total:     rows.reduce((a, r) => a + r.total, 0),
        delivered: rows.reduce((a, r) => a + r.delivered, 0),
    };
}

/** Soma as linhas de lead numa chave (campaign_id | ad_id). */
function sumLeadsBy(rows, keyField) {
    const map = new Map();
    for (const r of rows) {
        const k = r[keyField];
        if (!k) continue;
        const cur = map.get(k) || { total: 0, delivered: 0 };
        cur.total += r.total;
        cur.delivered += r.delivered;
        map.set(k, cur);
    }
    return map;
}

/** Idem, mas por conjunto — resolvido pelo anúncio (o lead não guarda adset). */
async function groupLeadsByAdSet(rows) {
    const adIds = [...new Set(rows.map(r => r.ad_id).filter(Boolean))];
    if (!adIds.length) return new Map();

    const ads = await MetaAd.findAll({
        where: { id: { [Op.in]: adIds } }, attributes: ['id', 'adset_id'], raw: true,
    });
    const adsetOf = new Map(ads.map(a => [String(a.id), a.adset_id ? String(a.adset_id) : null]));

    return sumLeadsBy(
        rows.map(r => ({ ...r, adset_id: adsetOf.get(r.ad_id) || null })),
        'adset_id',
    );
}

/** Totais agregados de um período (sem group by), já com os leads da base. */
async function periodTotals({ where, since, until, adsetId }) {
    const [row, scope] = await Promise.all([
        MetaInsightDaily.findOne({ where, attributes: SUM_ATTRS, raw: true }),
        leadScope(where, adsetId),
    ]);
    const leads = await officeLeadStats({ since, until, ...scope });
    return derive(row || {}, leads.total, leads.delivered);
}

/** Enxerta metadados do cache da entidade (nome, status, criativo...). */
async function attachMetadata(level, rows) {
    const ids = rows.map(r => r.entity_id);
    if (!ids.length) return rows;

    if (level === 'campaign') {
        const camps = await MetaCampaign.findAll({ where: { id: { [Op.in]: ids } } });
        const byId = new Map(camps.map(c => [String(c.id), c.get({ plain: true })]));
        return rows.map(r => ({ ...(byId.get(r.entity_id) || fallbackEntity(r)), ...r.metrics, id: r.entity_id, entity_id: r.entity_id }));
    }

    if (level === 'adset') {
        const adsets = await MetaAdSet.findAll({ where: { id: { [Op.in]: ids } } });
        const byId = new Map(adsets.map(a => [String(a.id), a.get({ plain: true })]));
        // Nome da campanha-mãe pra exibição
        const campIds = [...new Set(rows.map(r => r.campaign_id).filter(Boolean))];
        const campsById = await campaignNameMap(campIds);
        return rows.map(r => {
            const meta = byId.get(r.entity_id) || fallbackEntity(r);
            return {
                ...meta, ...r.metrics,
                id: r.entity_id, entity_id: r.entity_id,
                campaign_id: r.campaign_id || meta.campaign_id || null,
                campaign: campsById.get(String(r.campaign_id || meta.campaign_id)) || null,
            };
        });
    }

    // level === 'ad' — traz criativo completo do cache + campanha/conjunto
    const ads = await MetaAd.findAll({ where: { id: { [Op.in]: ids } } });
    const byId = new Map(ads.map(a => [String(a.id), a.get({ plain: true })]));
    const campIds = [...new Set(rows.map(r => r.campaign_id).filter(Boolean))];
    const campsById = await campaignNameMap(campIds);
    return rows.map(r => {
        const meta = byId.get(r.entity_id) || fallbackEntity(r);
        return {
            ...meta, ...r.metrics,
            id: r.entity_id, entity_id: r.entity_id,
            campaign_id: r.campaign_id || meta.campaign_id || null,
            adset_id: r.adset_id || meta.adset_id || null,
            campaign: campsById.get(String(r.campaign_id || meta.campaign_id)) || null,
        };
    });
}

/** Entidade que tem dado diário mas ainda não está no cache local (sync de estrutura pendente). */
function fallbackEntity(r) {
    return {
        name: null, status: null, effective_status: null,
        not_synced: true,
        account_id: r.account_id || null,
        campaign_id: r.campaign_id || null,
        adset_id: r.adset_id || null,
    };
}

async function campaignNameMap(campaignIds) {
    if (!campaignIds.length) return new Map();
    const camps = await MetaCampaign.findAll({
        where: { id: { [Op.in]: campaignIds } },
        attributes: ['id', 'name', 'account_id', 'account_name', 'objective', 'midia_slug', 'currency'],
    });
    return new Map(camps.map(c => [String(c.id), c.get({ plain: true })]));
}

/**
 * Relatório de um período.
 *
 * @param {object} opts
 *   since, until       — 'YYYY-MM-DD' (obrigatórios)
 *   level              — 'campaign' | 'adset' | 'ad'
 *   accountIds         — ['act_x', ...] filtro opcional
 *   campaignId         — escopo de drill (nível adset/ad)
 *   adsetId            — escopo de drill (nível ad)
 *
 * @returns { rows, series, totals, totals_prev, period, period_prev }
 */
export async function getReport({ since, until, level = 'campaign', accountIds = [], campaignId = null, adsetId = null } = {}) {
    if (!since || !until) throw new Error('Período (since/until) é obrigatório.');
    if (!YMD_RE.test(since) || !YMD_RE.test(until)) {
        throw new Error('Período deve estar no formato YYYY-MM-DD.');
    }
    if (!LEVELS.includes(level)) throw new Error(`Nível inválido: ${level}`);

    const where = buildWhere({ level, since, until, accountIds, campaignId, adsetId });

    // ── Leads da nossa base no mesmo escopo/período ─────────────────────────
    const scope = await leadScope(where, adsetId);
    const leadStats = await officeLeadStats({ since, until, ...scope });

    // Chave de atribuição por nível. Lead sem meta_ad_id (formulário do site,
    // ou webhook antigo sem o campo) entra nos totais mas não cai em linha de
    // anúncio/conjunto — por isso a soma das linhas pode ficar abaixo do total.
    let officeByEntity;
    if (level === 'campaign') {
        officeByEntity = sumLeadsBy(leadStats.rows, 'campaign_id');
    } else if (level === 'ad') {
        officeByEntity = sumLeadsBy(leadStats.rows, 'ad_id');
    } else {
        officeByEntity = await groupLeadsByAdSet(leadStats.rows);
    }

    // ── Linhas por entidade ─────────────────────────────────────────────────
    const grouped = await MetaInsightDaily.findAll({
        where,
        attributes: [
            'entity_id',
            [fn('MAX', col('account_id')),  'account_id'],
            [fn('MAX', col('campaign_id')), 'campaign_id'],
            [fn('MAX', col('adset_id')),    'adset_id'],
            ...SUM_ATTRS,
        ],
        group: ['entity_id'],
        raw: true,
    });

    const rows = await attachMetadata(level, grouped.map(g => {
        const l = officeByEntity.get(String(g.entity_id)) || { total: 0, delivered: 0 };
        return {
            entity_id: String(g.entity_id),
            account_id: g.account_id,
            campaign_id: g.campaign_id,
            adset_id: g.adset_id,
            metrics: derive(g, l.total, l.delivered),
        };
    }));

    // ── Série diária do escopo ──────────────────────────────────────────────
    const seriesRaw = await MetaInsightDaily.findAll({
        where,
        attributes: [['date', 'day'], ...SUM_ATTRS],
        group: ['date'],
        order: [[col('date'), 'ASC']],
        raw: true,
    });
    const leadsByDay = sumLeadsBy(leadStats.rows, 'day');
    const series = seriesRaw.map(s => {
        const day = String(s.day).slice(0, 10);
        const l = leadsByDay.get(day) || { total: 0, delivered: 0 };
        return {
            day,
            spend: +(Number(s.spend) || 0).toFixed(2),
            impressions: Number(s.impressions) || 0,
            clicks: Number(s.clicks) || 0,
            office_leads: l.total,
            office_leads_delivered: l.delivered,
        };
    });

    // ── Totais do período + período anterior (mesma duração, pros deltas) ──
    const totals = derive(grouped.reduce((acc, g) => ({
        spend: acc.spend + (Number(g.spend) || 0),
        impressions: acc.impressions + (Number(g.impressions) || 0),
        clicks: acc.clicks + (Number(g.clicks) || 0),
    }), { spend: 0, impressions: 0, clicks: 0 }), leadStats.total, leadStats.delivered);
    totals.entities = grouped.length;

    const dSince = new Date(`${since}T00:00:00Z`);
    const dUntil = new Date(`${until}T00:00:00Z`);
    const days = Math.max(1, Math.round((dUntil - dSince) / 86400000) + 1);
    const prevUntilD = new Date(dSince); prevUntilD.setUTCDate(prevUntilD.getUTCDate() - 1);
    const prevSinceD = new Date(prevUntilD); prevSinceD.setUTCDate(prevSinceD.getUTCDate() - (days - 1));
    const prevSince = ymd(prevSinceD);
    const prevUntil = ymd(prevUntilD);

    const totalsPrev = await periodTotals({
        where: buildWhere({ level, since: prevSince, until: prevUntil, accountIds, campaignId, adsetId }),
        since: prevSince, until: prevUntil, adsetId,
    });

    return {
        rows,
        series,
        totals,
        totals_prev: totalsPrev,
        period: { since, until, days },
        period_prev: { since: prevSince, until: prevUntil },
    };
}

/** Cobertura da série diária (pro front saber se precisa de backfill). */
export async function getCoverage() {
    const rows = await MetaInsightDaily.findAll({
        attributes: [
            'entity_level',
            [fn('MIN', col('date')), 'min_date'],
            [fn('MAX', col('date')), 'max_date'],
            [fn('COUNT', literal('*')), 'rows'],
        ],
        group: ['entity_level'],
        raw: true,
    });
    return rows.map(r => ({
        level: r.entity_level,
        min_date: r.min_date, max_date: r.max_date,
        rows: Number(r.rows) || 0,
    }));
}

export default { syncDaily, getReport, getCoverage };
