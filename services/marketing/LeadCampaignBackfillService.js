// services/marketing/LeadCampaignBackfillService.js
//
// Resolve meta_campaign_id de leads inbound que têm meta_ad_id preenchido mas
// perderam o campaign_id no import (cenário comum em históricos vindos de
// /{form_id}/leads — a Meta nem sempre devolve campaign_id pra leads orgânicos,
// de campanhas excluídas ou de teste).
//
// Funciona contra o cache local MetaAd (que tem campaign_id como FK lógica)
// — sem chamadas à Graph API. Dispara como passo automático do full sync
// (após sincronizar Ads) e via endpoint admin pra rodar sob demanda.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

const { InboundLead } = db;

/**
 * Backfill em batch — escaneia leads com meta_ad_id sem meta_campaign_id e
 * resolve via MetaAd.findAll. Idempotente (lead já com campaign_id é ignorado
 * naturalmente pela WHERE clause).
 *
 * @param {Object} opts
 * @param {number} opts.limit  - máx de leads por execução (default 2000)
 * @param {boolean} opts.dryRun - se true, não grava nada
 * @returns {Promise<{scanned:number, updated:number, unresolved:number, dryRun:boolean}>}
 */
export async function backfillCampaignsFromAds({ limit = 2000, dryRun = false } = {}) {
    if (!db.MetaAd) {
        return { scanned: 0, updated: 0, unresolved: 0, dryRun, skipped: 'MetaAd model não disponível' };
    }

    const candidates = await InboundLead.findAll({
        where: {
            meta_ad_id: { [Op.ne]: null },
            meta_campaign_id: { [Op.is]: null },
        },
        attributes: ['id', 'meta_ad_id'],
        limit: Math.min(2000, Math.max(1, Number(limit) || 2000)),
        order: [['created_at', 'DESC']],
    });

    if (!candidates.length) {
        return { scanned: 0, updated: 0, unresolved: 0, dryRun };
    }

    const adIds = [...new Set(candidates.map(l => l.meta_ad_id).filter(Boolean))];
    const ads = await db.MetaAd.findAll({
        where: { id: { [Op.in]: adIds } },
        attributes: ['id', 'campaign_id'],
        raw: true,
    });
    const adIx = new Map(ads.map(a => [String(a.id), a.campaign_id ? String(a.campaign_id) : null]));

    let updated = 0;
    let unresolved = 0;
    for (const l of candidates) {
        const camp = adIx.get(String(l.meta_ad_id));
        if (camp) {
            if (!dryRun) await l.update({ meta_campaign_id: camp });
            updated += 1;
        } else {
            unresolved += 1;
        }
    }

    return { scanned: candidates.length, updated, unresolved, dryRun };
}

export default { backfillCampaignsFromAds };
