// services/marketing/MetaAdService.js
//
// Sincroniza anúncios (Ads) de uma campanha Meta, com criativo + form vinculado
// + insights individuais. É o nível mais granular antes do criativo.

import axios from 'axios';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import MarketingConfigService from './MarketingConfigService.js';

const { MetaAd, MetaAdSet } = db;

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

/**
 * Tenta achar a melhor imagem disponível do creative, em ordem de qualidade:
 *  1. `creative.image_url` — imagem full size (1080x1080 ou maior)
 *  2. `object_story_spec.link_data.picture` — picture do link_data (boa qualidade)
 *  3. `object_story_spec.photo_data.url` — URL direta da foto
 *  4. `asset_feed_spec.images[0].url` — primeiro asset do feed dinâmico
 *  5. `creative.thumbnail_url` — fallback de última instância (~100px, ruim)
 */
function pickBestImage(creative) {
    if (!creative) return null;
    const oss = creative.object_story_spec || {};
    const ld = oss.link_data || {};
    const pd = oss.photo_data || {};
    const afs = creative.asset_feed_spec || {};

    if (creative.image_url)        return creative.image_url;
    if (ld.picture)                return ld.picture;
    if (pd.url)                    return pd.url;
    if (Array.isArray(afs.images) && afs.images[0]?.url) return afs.images[0].url;
    return creative.thumbnail_url || null;
}

/**
 * Coleta TODOS os image_hashes possíveis de um creative, em ordem de
 * prioridade. O primeiro que /adimages resolver vira a thumbnail final.
 */
function collectImageHashes(creative) {
    const hashes = [];
    if (!creative) return hashes;
    const oss = creative.object_story_spec || {};
    const ld = oss.link_data || {};
    const pd = oss.photo_data || {};
    const afs = creative.asset_feed_spec || {};

    if (creative.image_hash) hashes.push(creative.image_hash);
    if (ld.image_hash)       hashes.push(ld.image_hash);
    if (pd.image_hash)       hashes.push(pd.image_hash);

    // Carousel: cada child_attachment pode ter image_hash
    if (Array.isArray(ld.child_attachments)) {
        for (const ca of ld.child_attachments) {
            if (ca?.image_hash) hashes.push(ca.image_hash);
        }
    }
    // Asset feed: várias imagens
    if (Array.isArray(afs.images)) {
        for (const img of afs.images) {
            if (img?.hash) hashes.push(img.hash);
        }
    }

    // Dedupe preservando ordem
    return [...new Set(hashes)];
}

function extractCreativeFields(creative) {
    if (!creative) return {};
    const oss = creative.object_story_spec || {};
    const ld = oss.link_data || {};
    const vd = oss.video_data || {};
    const pd = oss.photo_data || {};

    const title   = creative.title || ld.name || vd.title || null;
    const body    = creative.body  || ld.message || vd.message || pd.caption || null;
    const linkUrl = ld.link || creative.url_tags || creative.template_url || null;
    const videoId = vd.video_id || creative.video_id || null;

    // Primeiro hash (principal) — usado pelo lookup /adimages
    const hashes = collectImageHashes(creative);
    const imageHash = hashes[0] || null;

    return {
        creative_id:          creative.id ? String(creative.id) : null,
        creative_thumbnail:   creative.thumbnail_url || null,
        creative_title:       title,
        creative_body:        body,
        creative_link_url:    linkUrl,
        creative_image_url:   pickBestImage(creative),
        creative_image_hash:  imageHash,
        creative_image_hashes: hashes.length ? hashes : null,    // todos pra resolver depois
        creative_video_id:    videoId,
        creative_object_type: creative.object_type || null,
    };
}

/**
 * Pra cada conta de anúncio, busca URLs ORIGINAIS das imagens via /adimages.
 * Esse endpoint devolve a URL stored (cdn.facebook.com original) que é muito
 * maior que o `image_url` que vem do creative direto (que às vezes é só 100px).
 *
 * Bate em chunks de 50 (limite Meta). Best-effort: falha silenciosa.
 */
async function resolveHighResImages({ token, base }, accountId, imageHashes) {
    const result = new Map();
    if (!imageHashes.length) return result;

    for (let i = 0; i < imageHashes.length; i += 50) {
        const chunk = imageHashes.slice(i, i + 50);
        try {
            const r = await axios.get(`${base}/${encodeURIComponent(accountId)}/adimages`, {
                params: {
                    access_token: token,
                    hashes: JSON.stringify(chunk),
                    fields: 'hash,url,permalink_url',
                },
                timeout: 20000,
            });
            for (const img of (r.data?.data || [])) {
                if (img.hash && img.url) result.set(img.hash, img.url);
            }
        } catch (e) {
            console.warn(`  ⚠️  [meta-ads] adimages falhou (chunk ${i}): ${e?.response?.data?.error?.message || e.message}`);
        }
    }
    return result;
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
            'adset_id', 'adset{name}', 'created_time', 'updated_time',
            // Thumbnail em resolução alta (sem o param ele vem em ~100px)
            'creative{id,thumbnail_url.dimensions(720x720),title,body,image_url,video_id,object_type,object_story_spec,asset_feed_spec,image_hash}',
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
                updated_time:     ad.updated_time ? new Date(ad.updated_time) : null,

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

    // ── Resolve imagens em alta via /act_{account_id}/adimages ────────────
    // Considera TODOS os hashes possíveis (não só o principal) — carousel,
    // asset feed, link/photo data aninhados. Pega o primeiro hash que /adimages
    // souber resolver.
    try {
        const camp = await db.MetaCampaign.findByPk(String(campaignId), { attributes: ['account_id'] });
        const accountId = camp?.account_id;
        if (accountId) {
            const ads = await MetaAd.findAll({
                where: { campaign_id: String(campaignId) },
                attributes: ['id', 'creative_image_hash', 'creative_image_hashes'],
            });
            // Coleta união de TODOS os hashes em todos os ads desta campanha.
            const allHashes = new Set();
            for (const ad of ads) {
                if (ad.creative_image_hash) allHashes.add(ad.creative_image_hash);
                if (Array.isArray(ad.creative_image_hashes)) {
                    for (const h of ad.creative_image_hashes) if (h) allHashes.add(h);
                }
            }
            if (allHashes.size) {
                const hashToUrl = await resolveHighResImages({ token, base }, accountId, [...allHashes]);
                if (hashToUrl.size) {
                    let updated = 0;
                    for (const ad of ads) {
                        const candidates = [
                            ad.creative_image_hash,
                            ...(Array.isArray(ad.creative_image_hashes) ? ad.creative_image_hashes : []),
                        ].filter(Boolean);
                        let hires = null;
                        for (const h of candidates) {
                            const url = hashToUrl.get(h);
                            if (url) { hires = url; break; }
                        }
                        if (hires) {
                            await MetaAd.update(
                                { creative_image_url: hires },
                                { where: { id: ad.id } },
                            );
                            updated += 1;
                        }
                    }
                    console.log(`  🖼️  [meta-ads] ${updated}/${ads.length} imagens resolvidas em alta resolução (${hashToUrl.size} hashes encontrados)`);
                }
            }
        }
    } catch (e) {
        console.warn(`⚠️  [meta-ads] resolução de imagens HD falhou: ${e.message}`);
    }

    // ── Busca a URL playable de vídeos (ads com video_id) ─────────────────
    // /{video_id}?fields=source,permalink_url retorna o MP4 + link público.
    // 1 chamada por vídeo único — limitado a 50 pra evitar rate limit.
    try {
        const videoAds = await MetaAd.findAll({
            where: { campaign_id: String(campaignId), creative_video_id: { [Op.ne]: null } },
            attributes: ['id', 'creative_video_id'],
        });
        const uniqueVideos = [...new Set(videoAds.map(a => a.creative_video_id).filter(Boolean))].slice(0, 50);
        for (const videoId of uniqueVideos) {
            try {
                const vr = await axios.get(`${base}/${encodeURIComponent(videoId)}`, {
                    params: { access_token: token, fields: 'source,permalink_url' },
                    timeout: 15000,
                });
                const src = vr.data?.source || null;
                const permalink = vr.data?.permalink_url
                    ? (vr.data.permalink_url.startsWith('http') ? vr.data.permalink_url : `https://www.facebook.com${vr.data.permalink_url}`)
                    : null;
                await MetaAd.update(
                    { creative_video_url: src, creative_video_permalink: permalink },
                    { where: { creative_video_id: videoId } },
                );
            } catch (e) {
                // Vídeos podem expirar — não falha o sync por causa de 1
                console.warn(`  ⚠️  [meta-ads] vídeo ${videoId}: ${e?.response?.data?.error?.message || e.message}`);
            }
        }
    } catch (e) {
        console.warn(`⚠️  [meta-ads] busca de video sources falhou: ${e.message}`);
    }

    // ── Sincroniza também os ad sets (conjuntos) — em sequência aos ads ───
    let adsetsResult = { adsets_total: 0, adsets_new: 0, adsets_updated: 0 };
    try {
        adsetsResult = await syncAdSetsForCampaign(campaignId, { sinceDays });
        console.log(`  📦 [meta-adsets] ${adsetsResult.adsets_total} conjuntos sincronizados (${adsetsResult.adsets_new} novos)`);
    } catch (e) {
        console.warn(`⚠️  [meta-adsets] sync falhou: ${e?.response?.data?.error?.message || e.message}`);
    }

    return {
        ads_total: adsTotal,
        ads_new: adsNew,
        ads_updated: adsUpdated,
        ...adsetsResult,
    };
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

/**
 * Sincroniza ad sets (conjuntos) de uma campanha com a Meta.
 * Fetch /{campaign-id}/adsets com insights agregados.
 */
export async function syncAdSetsForCampaign(campaignId, { sinceDays = 90 } = {}) {
    const { token, base } = await getCreds();

    const since = new Date();
    since.setDate(since.getDate() - sinceDays);
    const sinceStr = since.toISOString().slice(0, 10);
    const untilStr = new Date().toISOString().slice(0, 10);

    const url = `${base}/${encodeURIComponent(campaignId)}/adsets`;
    const params = {
        access_token: token,
        fields: [
            'id', 'name', 'status', 'effective_status',
            'optimization_goal', 'billing_event',
            'start_time', 'end_time', 'updated_time', 'created_time',
            'daily_budget', 'lifetime_budget',
            `insights.time_range({"since":"${sinceStr}","until":"${untilStr}"}).fields(spend,impressions,clicks,reach,ctr,cpm,cpc,actions)`,
        ].join(','),
        limit: 200,
    };

    let adsetsTotal = 0, adsetsNew = 0, adsetsUpdated = 0;
    let nextUrl = url, nextParams = params;

    for (let page = 0; page < 10; page++) {
        const r = await axios.get(nextUrl, { params: nextParams, timeout: 30000 });
        const data = Array.isArray(r.data?.data) ? r.data.data : [];

        for (const a of data) {
            adsetsTotal += 1;
            const ins = (Array.isArray(a.insights?.data) && a.insights.data[0]) || {};
            const payload = {
                id:                String(a.id),
                campaign_id:       String(campaignId),
                name:              a.name || null,
                status:            a.status || null,
                effective_status:  a.effective_status || null,
                optimization_goal: a.optimization_goal || null,
                billing_event:     a.billing_event || null,
                start_time:        a.start_time ? new Date(a.start_time) : null,
                end_time:          a.end_time ? new Date(a.end_time) : null,
                updated_time:      a.updated_time ? new Date(a.updated_time) : null,
                created_time:      a.created_time ? new Date(a.created_time) : null,
                daily_budget_cents:    a.daily_budget    ? Number(a.daily_budget)    : null,
                lifetime_budget_cents: a.lifetime_budget ? Number(a.lifetime_budget) : null,
                spend:             ins.spend ? Number(ins.spend) : 0,
                impressions:       Number(ins.impressions) || 0,
                clicks:            Number(ins.clicks) || 0,
                reach:             Number(ins.reach) || 0,
                ctr:               ins.ctr ? Number(ins.ctr) : null,
                cpm:               ins.cpm ? Number(ins.cpm) : null,
                cpc:               ins.cpc ? Number(ins.cpc) : null,
                meta_leads_total:  extractLeads(ins.actions),
                last_synced_at:    new Date(),
            };
            const existing = await MetaAdSet.findByPk(payload.id);
            if (!existing) { await MetaAdSet.create(payload); adsetsNew += 1; }
            else { Object.assign(existing, payload); await existing.save(); adsetsUpdated += 1; }
        }

        const next = r.data?.paging?.next;
        if (!next) break;
        nextUrl = next; nextParams = {};
    }

    return { adsets_total: adsetsTotal, adsets_new: adsetsNew, adsets_updated: adsetsUpdated };
}

/**
 * Lista os ad sets de uma campanha — com agregado de ads (count, spend, leads).
 */
export async function listAdSetsForCampaign(campaignId) {
    const adsets = await MetaAdSet.findAll({
        where: { campaign_id: String(campaignId) },
        order: [['spend', 'DESC'], ['name', 'ASC']],
    });
    if (!adsets.length) return [];

    // Conta ads e agrega métricas que já temos cacheadas em MetaAd (caso queiramos checar).
    const adsetIds = adsets.map(a => a.id);
    const ads = await MetaAd.findAll({
        where: { adset_id: { [Op.in]: adsetIds } },
        attributes: ['adset_id', 'id'],
    });
    const adsCount = new Map();
    for (const ad of ads) {
        const k = String(ad.adset_id);
        adsCount.set(k, (adsCount.get(k) || 0) + 1);
    }

    return adsets.map(a => {
        const plain = a.get({ plain: true });
        return {
            ...plain,
            ads_count: adsCount.get(String(plain.id)) || 0,
        };
    });
}

/**
 * Lista TODOS os ads (cache) com info da campanha + form vinculado.
 * Pra view de Anúncios na tela /marketing/campanhas.
 */
export async function listAll() {
    const ads = await MetaAd.findAll({
        order: [['spend', 'DESC'], ['name', 'ASC']],
    });
    if (!ads.length) return [];

    // JOIN com MetaCampaign pra trazer nome da campanha + conta
    const campaignIds = [...new Set(ads.map(a => a.campaign_id).filter(Boolean))];
    const campaignsById = new Map();
    if (campaignIds.length && db.MetaCampaign) {
        const camps = await db.MetaCampaign.findAll({
            where: { id: { [Op.in]: campaignIds } },
            attributes: [
                'id', 'name', 'account_id', 'account_name', 'objective',
                'effective_status', 'status', 'start_time', 'stop_time',
                'midia_slug', 'currency',
            ],
        });
        for (const c of camps) campaignsById.set(String(c.id), c.get({ plain: true }));
    }

    // JOIN com MetaLeadForm
    const formIds = [...new Set(ads.map(a => a.lead_form_id).filter(Boolean))];
    const formsById = new Map();
    if (formIds.length && db.MetaLeadForm) {
        const forms = await db.MetaLeadForm.findAll({
            where: { id: { [Op.in]: formIds } },
            attributes: ['id', 'name', 'page_name', 'status', 'questions', 'midia_slug'],
        });
        for (const f of forms) formsById.set(String(f.id), f.get({ plain: true }));
    }

    return ads.map(a => {
        const plain = a.get({ plain: true });
        return {
            ...plain,
            campaign:  plain.campaign_id  ? (campaignsById.get(String(plain.campaign_id))  || null) : null,
            lead_form: plain.lead_form_id ? (formsById.get(String(plain.lead_form_id))     || null) : null,
        };
    });
}

export default { syncForCampaign, listForCampaign, listAll, syncAdSetsForCampaign, listAdSetsForCampaign };
