// services/marketing/MetaAdService.js
//
// Sincroniza anúncios (Ads) de uma campanha Meta, com criativo + form vinculado
// + insights individuais. É o nível mais granular antes do criativo.

import axios from 'axios';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import MarketingConfigService from './MarketingConfigService.js';

const { MetaAd } = db;

async function getCreds() {
    const cfg = await MarketingConfigService.getConfig({ withSecrets: true, useCache: false });
    const token = cfg.meta_access_token;
    const version = cfg.meta_graph_api_version || 'v21.0';
    if (!token) throw new Error('Token de acesso do Meta não configurado.');
    return { token, version, base: `https://graph.facebook.com/${version}` };
}

// Action types que indicam leads (mesmos da MetaCampaignService).
const LEAD_ACTION_TYPES = [
    'lead', 'onsite_conversion.lead_grouped', 'leadgen.other',
    'offsite_conversion.fb_pixel_lead',
];

function extractLeads(actions) {
    if (!Array.isArray(actions)) return 0;
    for (const t of LEAD_ACTION_TYPES) {
        const f = actions.find(a => a.action_type === t);
        if (f && Number(f.value) > 0) return Number(f.value);
    }
    return 0;
}

/**
 * Extrai o lead_form_id de várias estruturas possíveis do creative:
 *   - object_story_spec.link_data.call_to_action.value.lead_gen_form_id
 *   - object_story_spec.video_data.call_to_action.value.lead_gen_form_id
 *   - object_story_spec.text_data.call_to_action.value.lead_gen_form_id
 *   - asset_feed_spec.call_to_actions[].value.lead_gen_form_id
 */
function extractLeadFormId(creative) {
    if (!creative) return null;
    const oss = creative.object_story_spec;
    if (oss) {
        const candidates = [oss.link_data, oss.video_data, oss.text_data, oss.photo_data];
        for (const cd of candidates) {
            const ctav = cd?.call_to_action?.value;
            if (ctav?.lead_gen_form_id) return String(ctav.lead_gen_form_id);
        }
    }
    const afs = creative.asset_feed_spec;
    if (Array.isArray(afs?.call_to_actions)) {
        for (const cta of afs.call_to_actions) {
            if (cta?.value?.lead_gen_form_id) return String(cta.value.lead_gen_form_id);
        }
    }
    return null;
}

function extractCreativeFields(creative) {
    if (!creative) return {};
    const oss = creative.object_story_spec || {};
    const ld = oss.link_data || {};
    const vd = oss.video_data || {};
    const pd = oss.photo_data || {};

    const title = creative.title || ld.name || vd.title || null;
    const body  = creative.body || ld.message || vd.message || pd.caption || null;
    const linkUrl = ld.link || creative.url_tags || creative.template_url || null;
    const imageUrl = creative.image_url || ld.image_hash ? (ld.picture || creative.image_url) : (creative.image_url || ld.picture);
    const videoId = vd.video_id || null;

    return {
        creative_id:          creative.id ? String(creative.id) : null,
        creative_thumbnail:   creative.thumbnail_url || null,
        creative_title:       title,
        creative_body:        body,
        creative_link_url:    linkUrl,
        creative_image_url:   imageUrl,
        creative_video_id:    videoId,
        creative_object_type: creative.object_type || null,
    };
}

/**
 * Sincroniza os ads de uma campanha. Retorna { ads_total, ads_new, ads_updated }.
 */
export async function syncForCampaign(campaignId, { sinceDays = 90 } = {}) {
    const { token, base } = await getCreds();

    const since = new Date();
    since.setDate(since.getDate() - sinceDays);
    const sinceStr = since.toISOString().slice(0, 10);
    const untilStr = new Date().toISOString().slice(0, 10);

    const url = `${base}/${encodeURIComponent(campaignId)}/ads`;
    const params = {
        access_token: token,
        fields: [
            'id', 'name', 'status', 'effective_status',
            'adset_id', 'adset{name}', 'created_time',
            'creative{id,thumbnail_url,title,body,image_url,object_type,object_story_spec,asset_feed_spec}',
            `insights.time_range({"since":"${sinceStr}","until":"${untilStr}"}).fields(spend,impressions,clicks,ctr,cpm,cpc,actions)`,
        ].join(','),
        limit: 200,
    };

    let adsTotal = 0, adsNew = 0, adsUpdated = 0;
    const seenIds = new Set();

    let nextUrl = url, nextParams = params;
    for (let page = 0; page < 20; page++) {  // até 4000 ads
        const r = await axios.get(nextUrl, { params: nextParams, timeout: 30000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];

        for (const ad of data) {
            adsTotal += 1;
            seenIds.add(String(ad.id));

            const ins = (Array.isArray(ad.insights?.data) && ad.insights.data[0]) || {};
            const creative = extractCreativeFields(ad.creative);
            const leadFormId = extractLeadFormId(ad.creative);

            const payload = {
                id:               String(ad.id),
                campaign_id:      String(campaignId),
                adset_id:         ad.adset_id ? String(ad.adset_id) : null,
                adset_name:       ad.adset?.name || null,
                name:             ad.name || null,
                status:           ad.status || null,
                effective_status: ad.effective_status || null,
                created_time:     ad.created_time ? new Date(ad.created_time) : null,

                ...creative,
                lead_form_id:     leadFormId,

                spend:            ins.spend ? Number(ins.spend) : 0,
                impressions:      Number(ins.impressions) || 0,
                clicks:           Number(ins.clicks) || 0,
                ctr:              ins.ctr ? Number(ins.ctr) : null,
                cpm:              ins.cpm ? Number(ins.cpm) : null,
                cpc:              ins.cpc ? Number(ins.cpc) : null,
                meta_leads_total: extractLeads(ins.actions),
                last_synced_at:   new Date(),
            };

            const existing = await MetaAd.findByPk(payload.id);
            if (!existing) {
                await MetaAd.create(payload);
                adsNew += 1;
            } else {
                Object.assign(existing, payload);
                await existing.save();
                adsUpdated += 1;
            }
        }

        const next = r.data?.paging?.next;
        if (!next) break;
        nextUrl = next; nextParams = {};
    }

    return { ads_total: adsTotal, ads_new: adsNew, ads_updated: adsUpdated };
}

/**
 * Lista ads de uma campanha (do cache local) já com info do lead_form enxertada
 * (nome, página, status na Meta, perguntas).
 */
export async function listForCampaign(campaignId, { activeOnly = false } = {}) {
    const where = { campaign_id: String(campaignId) };
    if (activeOnly) where.effective_status = { [Op.iLike]: 'ACTIVE%' };

    const rows = await MetaAd.findAll({
        where,
        order: [['spend', 'DESC'], ['name', 'ASC']],
    });
    if (!rows.length) return [];

    // JOIN em memória com MetaLeadForm — pegamos só os ids únicos pra economizar query.
    const formIds = [...new Set(rows.map(r => r.lead_form_id).filter(Boolean))];
    const formsById = new Map();
    if (formIds.length && db.MetaLeadForm) {
        const forms = await db.MetaLeadForm.findAll({
            where: { id: { [Op.in]: formIds } },
            attributes: ['id', 'name', 'page_name', 'status', 'created_time', 'questions', 'midia_slug', 'mapping_active'],
        });
        for (const f of forms) formsById.set(String(f.id), f.get({ plain: true }));
    }

    return rows.map(r => {
        const plain = r.get({ plain: true });
        return {
            ...plain,
            lead_form: plain.lead_form_id ? (formsById.get(String(plain.lead_form_id)) || null) : null,
        };
    });
}

export default { syncForCampaign, listForCampaign };
