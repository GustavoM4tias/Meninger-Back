// controllers/marketing/metaCampaignController.js
//
// Endpoints admin pras campanhas Meta cacheadas + insights + agregados de leads
// + import histórico + reconciliação com CV.

import MetaCampaignService from '../../services/marketing/MetaCampaignService.js';
import MetaHistoricalImportService from '../../services/marketing/MetaHistoricalImportService.js';
import CvReconciliationService from '../../services/marketing/CvReconciliationService.js';
import MetaAdService from '../../services/marketing/MetaAdService.js';

export async function list(req, res) {
    try {
        const includeArchived = req.query.archived === 'true' || req.query.archived === '1';
        const campaigns = await MetaCampaignService.getAll({ includeArchived });
        return res.json({ ok: true, results: campaigns });
    } catch (err) {
        console.error(`❌ [meta-campaigns] list: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar campanhas.' });
    }
}

export async function sync(req, res) {
    try {
        const sinceDays = Math.min(Math.max(Number(req.body?.sinceDays) || 90, 7), 365);
        const result = await MetaCampaignService.syncFromMeta({ sinceDays });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-campaigns] sync: ${err.message}`);
        const detail = err?.response?.data?.error?.message || err.message;
        return res.status(500).json({
            ok: false,
            error: `Erro ao sincronizar com a Meta: ${detail}`,
            hint: detail.includes('permission') || detail.includes('Permission')
                ? 'Confirme que o token tem ads_read + business_management e que as contas de anúncio estão atribuídas ao System User.'
                : null,
        });
    }
}

export async function detail(req, res) {
    try {
        const { id } = req.params;
        const campaign = await MetaCampaignService.getById(id);
        if (!campaign) return res.status(404).json({ ok: false, error: 'Campanha não encontrada.' });
        return res.json({ ok: true, campaign });
    } catch (err) {
        console.error(`❌ [meta-campaigns] detail: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

export async function campaignLeads(req, res) {
    try {
        const { id } = req.params;
        const limit = Math.min(Number(req.query.limit) || 50, 500);
        const leads = await MetaCampaignService.listCampaignLeads(id, { limit });
        return res.json({ ok: true, results: leads });
    } catch (err) {
        console.error(`❌ [meta-campaigns] leads: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

export async function dailyBreakdown(req, res) {
    try {
        const { id } = req.params;
        const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
        const data = await MetaCampaignService.getDailyBreakdown(id, { days });
        return res.json({ ok: true, results: data });
    } catch (err) {
        console.error(`❌ [meta-campaigns] daily: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

export async function update(req, res) {
    try {
        const { id } = req.params;
        const updated = await MetaCampaignService.updateInternal(id, req.body || {});
        return res.json({ ok: true, campaign: updated });
    } catch (err) {
        console.error(`❌ [meta-campaigns] update: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/**
 * Importa leads históricos da Meta (últimos N dias) pra dentro do inbound_leads.
 * Entram com status='historical' — não disparam pro CV.
 */
export async function importHistoricalLeads(req, res) {
    try {
        const sinceDays = Math.min(Math.max(Number(req.body?.sinceDays) || 90, 1), 365);
        const result = await MetaHistoricalImportService.importHistorical({ sinceDays });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-campaigns] importHistoricalLeads: ${err.message}`);
        const detail = err?.response?.data?.error?.message || err.message;
        return res.status(500).json({ ok: false, error: `Erro ao importar histórico: ${detail}` });
    }
}

/** Re-processa leads Meta com o parser atual (preenche campos null). */
export async function reparseExistingLeads(req, res) {
    try {
        const onlyMissingNome = req.body?.onlyMissingNome !== false;
        const result = await MetaHistoricalImportService.reparseExistingLeads({ onlyMissingNome });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-campaigns] reparseExistingLeads: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Reconcilia em lote leads históricos com o CV. */
export async function reconcileHistoricalWithCv(req, res) {
    try {
        const limit = Math.min(Number(req.body?.limit) || 100, 500);
        const result = await CvReconciliationService.reconcileBatch({
            limit, channel: 'meta_lead_ads', status: 'historical',
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-campaigns] reconcileHistoricalWithCv: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Lista os ads de uma campanha (cache local). */
export async function campaignAds(req, res) {
    try {
        const { id } = req.params;
        const activeOnly = req.query.active === 'true';
        const ads = await MetaAdService.listForCampaign(id, { activeOnly });
        return res.json({ ok: true, results: ads });
    } catch (err) {
        console.error(`❌ [meta-campaigns] campaignAds: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Migra mappings de forms → campanhas (copia campos vazios). Idempotente. */
export async function migrateMappingsFormToCampaign(req, res) {
    try {
        const result = await MetaCampaignService.migrateFormMappingsToCampaigns();
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-campaigns] migrateMappings: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Sincroniza os ads de uma campanha com a Meta. */
export async function syncCampaignAds(req, res) {
    try {
        const { id } = req.params;
        const sinceDays = Math.min(Math.max(Number(req.body?.sinceDays) || 90, 1), 365);
        const result = await MetaAdService.syncForCampaign(id, { sinceDays });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-campaigns] syncCampaignAds: ${err.message}`);
        const detail = err?.response?.data?.error?.message || err.message;
        return res.status(500).json({ ok: false, error: `Erro ao sincronizar ads: ${detail}` });
    }
}

export default {
    list, sync, detail, campaignLeads, dailyBreakdown, update,
    importHistoricalLeads, reconcileHistoricalWithCv, reparseExistingLeads,
    migrateMappingsFormToCampaign,
    campaignAds, syncCampaignAds,
};
