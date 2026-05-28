// services/marketing/MetaLeadFormService.js
//
// Sincroniza os Lead Forms da Meta pro cache local. Fluxo:
//   1. GET /me/accounts → todas as Páginas que o System User vê
//   2. Pra cada Página, GET /{page-id}/leadgen_forms → forms ativos/arquivados
//   3. Upsert no banco — preserva o mapping local (empreendimentos, midia) se
//      já tiver sido configurado pelo admin.
//
// O sync é manual (botão "Sincronizar" na UI) — não roda sozinho. Em vista do
// volume baixo de forms novos (alguns por semana), não compensa rodar cron.

import axios from 'axios';
import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';
import MarketingConfigService from './MarketingConfigService.js';
import { CV_TARGET_FIELDS, autoDetectCvField } from './MetaLeadAdsService.js';

const { MetaLeadForm, InboundLead } = db;

async function getCreds() {
    const cfg = await MarketingConfigService.getConfig({ withSecrets: true, useCache: false });
    const token = cfg.meta_access_token;
    const version = cfg.meta_graph_api_version || 'v21.0';
    if (!token) throw new Error('Token de acesso do Meta não configurado.');
    return { token, version, base: `https://graph.facebook.com/${version}` };
}

/**
 * Lista as Páginas acessíveis pelo System User junto com o Page Access Token
 * de cada uma. /leadgen_forms exige Page Access Token (não funciona com User
 * token — devolve erro #190 "must be called with a Page Access Token").
 */
async function listPages({ token, base }) {
    const r = await axios.get(`${base}/me/accounts`, {
        params: { access_token: token, fields: 'id,name,access_token', limit: 100 },
        timeout: 20000,
    });
    return Array.isArray(r.data?.data) ? r.data.data : [];
}

/**
 * Lista os lead forms de uma Página. Inclui forms arquivados/desativados.
 * Usa o Page Access Token específico (page.access_token vindo do /me/accounts).
 */
async function listFormsForPage(base, pageId, pageAccessToken) {
    if (!pageAccessToken) {
        throw new Error('Sem Page Access Token — confirme que o System User tem permissão pages_show_list + pages_read_engagement + leads_retrieval nessa Página.');
    }
    const all = [];
    let url = `${base}/${pageId}/leadgen_forms`;
    let params = {
        access_token: pageAccessToken,
        fields: 'id,name,status,locale,created_time,questions{key,label,type}',
        limit: 100,
    };
    // Paginação cursor-based da Graph API.
    for (let i = 0; i < 10; i++) { // safety: até 10 páginas (1000 forms)
        const r = await axios.get(url, { params, timeout: 20000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];
        all.push(...data);
        const next = r.data?.paging?.next;
        if (!next) break;
        url = next;
        params = {}; // o next URL já tem todos os params encoded
    }
    return all;
}

/**
 * Sincroniza forms da Meta. Retorna { pages, forms_total, forms_new, forms_updated }.
 * Preserva mapping local (bound_empreendimentos, midia_slug, cv_origem, mapping_active).
 */
export async function syncFromMeta() {
    const creds = await getCreds();
    const pages = await listPages(creds);

    let formsTotal = 0;
    let formsNew = 0;
    let formsUpdated = 0;
    const errors = [];

    for (const page of pages) {
        let formList;
        try {
            // /leadgen_forms exige Page Access Token (não User/System User token).
            // O page.access_token vem do /me/accounts quando o System User tem
            // permissão pages_show_list + acesso atribuído à Página.
            formList = await listFormsForPage(creds.base, page.id, page.access_token);
        } catch (err) {
            const detail = err?.response?.data?.error?.message || err.message;
            errors.push({ page_id: page.id, page_name: page.name, error: detail });
            continue;
        }

        for (const f of formList) {
            formsTotal += 1;
            const existing = await MetaLeadForm.findByPk(String(f.id));
            const payload = {
                id:           String(f.id),
                page_id:      String(page.id),
                page_name:    page.name || null,
                name:         f.name || null,
                status:       f.status || null,
                locale:       f.locale || null,
                created_time: f.created_time ? new Date(f.created_time) : null,
                questions:    Array.isArray(f.questions) ? f.questions : (f.questions?.data || null),
                last_synced_at: new Date(),
            };

            if (!existing) {
                await MetaLeadForm.create({
                    ...payload,
                    mapping_active: true, // default — mas sem binding ainda
                });
                formsNew += 1;
            } else {
                // Atualiza só metadata vinda da Meta — preserva mapping local.
                existing.page_id        = payload.page_id;
                existing.page_name      = payload.page_name;
                existing.name           = payload.name;
                existing.status         = payload.status;
                existing.locale         = payload.locale;
                existing.created_time   = payload.created_time;
                existing.questions      = payload.questions;
                existing.last_synced_at = payload.last_synced_at;
                await existing.save();
                formsUpdated += 1;
            }
        }
    }

    return {
        pages_count: pages.length,
        forms_total: formsTotal,
        forms_new: formsNew,
        forms_updated: formsUpdated,
        errors,
    };
}

/**
 * Lista todos os forms cacheados (com mapping + agregados de leads).
 * Junta com inbound_leads pra calcular total, 30d, delivered, held, last_lead_at.
 */
export async function getAll() {
    const rows = await MetaLeadForm.findAll({
        order: [['status', 'ASC'], ['name', 'ASC']],
    });
    if (!rows.length) return [];

    const formIds = rows.map(r => r.id);

    // Agregados de leads — uma única query pra todos os forms.
    // sub-counts via SUM(CASE WHEN ...) — compatível com Postgres.
    const stats = await InboundLead.findAll({
        where: { meta_form_id: { [Op.in]: formIds } },
        attributes: [
            ['meta_form_id', 'meta_form_id'],
            [fn('COUNT', col('id')), 'total'],
            [fn('SUM', literal(`CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END`)), 'last_30d'],
            [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN 1 ELSE 0 END`)), 'delivered'],
            [fn('SUM', literal(`CASE WHEN status = 'held'      THEN 1 ELSE 0 END`)), 'held'],
            [fn('SUM', literal(`CASE WHEN status = 'spam'      THEN 1 ELSE 0 END`)), 'spam'],
            [fn('SUM', literal(`CASE WHEN status IN ('failed','rejected') THEN 1 ELSE 0 END`)), 'failed'],
            [fn('MAX', col('created_at')), 'last_lead_at'],
        ],
        group: ['meta_form_id'],
        raw: true,
    });

    const byFormId = new Map();
    for (const s of stats) {
        byFormId.set(String(s.meta_form_id), {
            total:        Number(s.total)        || 0,
            last_30d:     Number(s.last_30d)     || 0,
            delivered:    Number(s.delivered)    || 0,
            held:         Number(s.held)         || 0,
            spam:         Number(s.spam)         || 0,
            failed:       Number(s.failed)       || 0,
            last_lead_at: s.last_lead_at || null,
        });
    }

    return rows.map(r => ({
        ...r.get({ plain: true }),
        stats: byFormId.get(String(r.id)) || {
            total: 0, last_30d: 0, delivered: 0, held: 0, spam: 0, failed: 0, last_lead_at: null,
        },
    }));
}

/** Busca um form por id (= meta_form_id). */
export async function findById(metaFormId) {
    const row = await MetaLeadForm.findByPk(String(metaFormId));
    return row ? row.get({ plain: true }) : null;
}

/**
 * Lista leads desse form (default 20, sem cv_idlead filter).
 * `limit=0` = todos (pra export CSV).
 */
export async function listRecentLeads(metaFormId, { limit = 20, withCv = null } = {}) {
    const where = { meta_form_id: String(metaFormId) };
    if (withCv === true)  where.cv_idlead = { [Op.ne]: null };
    if (withCv === false) where.cv_idlead = null;

    const query = {
        where,
        attributes: [
            'id', 'nome', 'email', 'telefone', 'channel', 'status',
            'midia_slug', 'cv_origem', 'meta_campaign_id', 'meta_ad_id',
            'cv_idlead', 'is_spam', 'created_at',
            'cidade', 'estado', 'extra_fields',
        ],
        order: [['created_at', 'DESC']],
    };
    if (limit > 0) query.limit = limit;
    const leads = await InboundLead.findAll(query);
    return leads.map(l => l.get({ plain: true }));
}

/**
 * Comparação 3 colunas: Meta (insights), Office (nosso DB), CV (matched).
 * Mostra o funil de perda Meta → RD/Office → CV.
 */
export async function getComparison(metaFormId) {
    const form = await MetaLeadForm.findByPk(String(metaFormId));
    if (!form) throw new Error('Formulário Meta não encontrado.');

    const { MetaAd } = db;

    // Meta-side: soma de leads dos ads que usam esse form (vem dos insights).
    const adsAgg = await MetaAd.findAll({
        where: { lead_form_id: String(metaFormId) },
        attributes: [
            [fn('COALESCE', fn('SUM', col('meta_leads_total')), 0), 'meta_leads'],
            [fn('COALESCE', fn('SUM', col('spend')), 0), 'spend'],
            [fn('COALESCE', fn('SUM', col('impressions')), 0), 'impressions'],
            [fn('COALESCE', fn('SUM', col('clicks')), 0), 'clicks'],
            [fn('COUNT', col('id')), 'ads_count'],
        ],
        raw: true,
    });

    // Office-side + CV-side agregados.
    const officeAgg = await InboundLead.findAll({
        where: { meta_form_id: String(metaFormId) },
        attributes: [
            [fn('COUNT', col('id')), 'total'],
            [fn('SUM', literal(`CASE WHEN status='historical'                          THEN 1 ELSE 0 END`)), 'historical'],
            [fn('SUM', literal(`CASE WHEN status='delivered'                           THEN 1 ELSE 0 END`)), 'delivered'],
            [fn('SUM', literal(`CASE WHEN status='held'                                THEN 1 ELSE 0 END`)), 'held'],
            [fn('SUM', literal(`CASE WHEN status='spam'                                THEN 1 ELSE 0 END`)), 'spam'],
            [fn('SUM', literal(`CASE WHEN status IN ('failed','rejected')              THEN 1 ELSE 0 END`)), 'failed'],
            [fn('SUM', literal(`CASE WHEN cv_idlead IS NOT NULL                        THEN 1 ELSE 0 END`)), 'cv_matched'],
            [fn('SUM', literal(`CASE WHEN cv_idlead IS NULL                            THEN 1 ELSE 0 END`)), 'cv_unmatched'],
            [fn('MIN', col('created_at')), 'first_lead_at'],
            [fn('MAX', col('created_at')), 'last_lead_at'],
        ],
        raw: true,
    });

    const a = adsAgg[0] || {};
    const o = officeAgg[0] || {};
    const meta_leads   = Number(a.meta_leads)   || 0;
    const office_total = Number(o.total)        || 0;
    const cv_matched   = Number(o.cv_matched)   || 0;

    // Taxas
    const office_vs_meta = meta_leads > 0  ? (office_total / meta_leads) * 100 : null;
    const cv_vs_office   = office_total > 0 ? (cv_matched / office_total) * 100 : null;
    const cv_vs_meta     = meta_leads > 0  ? (cv_matched / meta_leads) * 100 : null;

    return {
        form: {
            id: form.id,
            name: form.name,
            page_name: form.page_name,
            status: form.status,
            created_time: form.created_time,
        },
        meta: {
            leads: meta_leads,
            spend: Number(a.spend) || 0,
            impressions: Number(a.impressions) || 0,
            clicks: Number(a.clicks) || 0,
            ads_count: Number(a.ads_count) || 0,
        },
        office: {
            total: office_total,
            historical: Number(o.historical) || 0,
            delivered:  Number(o.delivered)  || 0,
            held:       Number(o.held)       || 0,
            spam:       Number(o.spam)       || 0,
            failed:     Number(o.failed)     || 0,
            first_lead_at: o.first_lead_at,
            last_lead_at:  o.last_lead_at,
        },
        cv: {
            matched: cv_matched,
            unmatched: Number(o.cv_unmatched) || 0,
        },
        rates: {
            office_vs_meta_pct: office_vs_meta != null ? Number(office_vs_meta.toFixed(1)) : null,
            cv_vs_office_pct:   cv_vs_office   != null ? Number(cv_vs_office.toFixed(1))   : null,
            cv_vs_meta_pct:     cv_vs_meta     != null ? Number(cv_vs_meta.toFixed(1))     : null,
        },
        gaps: {
            meta_minus_office: Math.max(0, meta_leads - office_total),
            office_minus_cv:   Math.max(0, office_total - cv_matched),
            meta_minus_cv:     Math.max(0, meta_leads - cv_matched),
        },
    };
}

/** Gera CSV dos leads desse form. */
export async function exportLeadsCsv(metaFormId, { withCv = null } = {}) {
    const leads = await listRecentLeads(metaFormId, { limit: 0, withCv });

    const headers = [
        'id', 'created_at', 'channel', 'status',
        'nome', 'email', 'telefone',
        'cidade', 'estado',
        'midia_slug', 'cv_origem',
        'meta_campaign_id', 'meta_ad_id', 'meta_form_id',
        'cv_idlead', 'extra_fields',
    ];

    const escape = (v) => {
        if (v == null) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        // RFC 4180 — aspas duplas escapadas
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };

    const lines = [headers.join(',')];
    for (const l of leads) {
        lines.push(headers.map(h => {
            if (h === 'created_at' && l[h]) return escape(new Date(l[h]).toISOString());
            if (h === 'meta_form_id') return escape(metaFormId);
            return escape(l[h]);
        }).join(','));
    }
    return lines.join('\n');
}

/**
 * Atualiza o mapping local de um form. Aceita os campos do mapping + metadados
 * internos + UTMs default + cv_extra_fields.
 */
const ALLOWED_PATCH_FIELDS = [
    // Vínculo / roteamento (legado — migrou pra MetaCampaign mas mantemos como fallback)
    'bound_empreendimentos', 'midia_slug', 'cv_origem', 'tags', 'mapping_active',
    // Gestão
    'description', 'priority', 'campaign_ref',
    // UTMs default (legado — também migrou pra MetaCampaign)
    'default_utm_source', 'default_utm_medium', 'default_utm_campaign',
    'default_utm_content', 'default_utm_term',
    // Campos extras pro CV (legado)
    'cv_extra_fields',
    // Mapeamento por pergunta → campo CV
    'field_mappings',
];

export async function updateMapping(metaFormId, patch = {}) {
    const row = await MetaLeadForm.findByPk(String(metaFormId));
    if (!row) throw new Error('Formulário Meta não encontrado.');

    for (const k of ALLOWED_PATCH_FIELDS) {
        if (patch[k] !== undefined) row[k] = patch[k];
    }
    await row.save();
    return row.get({ plain: true });
}

/**
 * Retorna a estrutura do form com cada pergunta + mapping atual + sugestão
 * de auto-detect. Usado pelo editor de mapeamento.
 */
export async function getFieldMappingEditor(metaFormId) {
    const form = await MetaLeadForm.findByPk(String(metaFormId));
    if (!form) throw new Error('Form não encontrado.');

    const questions = Array.isArray(form.questions) ? form.questions : [];
    const current = form.field_mappings && typeof form.field_mappings === 'object'
        ? form.field_mappings : {};

    const items = questions.map(q => {
        const key = q.key;
        const auto = autoDetectCvField(key);
        return {
            question_key: key,
            question_label: q.label || key,
            question_type: q.type || null,
            auto_detected: auto,                                  // o que o parser usaria automaticamente
            current_mapping: current[key] ?? null,                // o que tá configurado (null = usa auto)
            effective: current[key] ?? auto ?? 'extra',           // o que vai acontecer de fato
        };
    });

    return {
        form: { id: form.id, name: form.name, page_name: form.page_name },
        items,
        available_targets: CV_TARGET_FIELDS,
    };
}

/** Atualiza só os field_mappings (mais granular que updateMapping). */
export async function updateFieldMappings(metaFormId, mappings) {
    const row = await MetaLeadForm.findByPk(String(metaFormId));
    if (!row) throw new Error('Form não encontrado.');

    // Sanitiza: aceita só keys que existem em questions e valores que estão no CV_TARGET_KEYS.
    const valid = {};
    const allowedTargets = new Set(CV_TARGET_FIELDS.map(f => f.key));
    if (mappings && typeof mappings === 'object') {
        for (const [k, v] of Object.entries(mappings)) {
            if (v == null || v === '') continue;             // null/empty = remove mapping (volta pro auto)
            if (allowedTargets.has(v)) valid[k] = v;
        }
    }
    row.field_mappings = Object.keys(valid).length ? valid : null;
    await row.save();
    return row.get({ plain: true });
}

export default {
    syncFromMeta, getAll, findById, updateMapping,
    listRecentLeads, getComparison, exportLeadsCsv,
    getFieldMappingEditor, updateFieldMappings,
};
