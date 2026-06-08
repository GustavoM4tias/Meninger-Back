// scheduler/marketingSyncScheduler.js
//
// 2 jobs que mantêm os dados Meta atualizados automaticamente:
//
//   FULL — varre tudo (forms + campanhas + ads + leads históricos + reconciliação).
//          Cron padrão: 06:20 → 18:20 a cada 2h ("20 6-18/2 * * *") = 7x/dia.
//
//   LIGHT — só refresca insights de campanhas (rápido).
//          Cron padrão: 15 em 15 minutos ("*/15 * * * *").
//
// Liga/desliga via env: ENABLE_MARKETING_AUTO_SYNC (default 'true').
// Override de cron:
//   MARKETING_FULL_SYNC_CRON
//   MARKETING_LIGHT_SYNC_CRON

import cron from 'node-cron';
import db from '../models/sequelize/index.js';

import MetaLeadFormService     from '../services/marketing/MetaLeadFormService.js';
import MetaCampaignService     from '../services/marketing/MetaCampaignService.js';
import MetaAdService           from '../services/marketing/MetaAdService.js';
import MetaHistoricalImportService from '../services/marketing/MetaHistoricalImportService.js';
import CvReconciliationService from '../services/marketing/CvReconciliationService.js';
import LeadCampaignBackfillService from '../services/marketing/LeadCampaignBackfillService.js';

const FULL_CRON  = process.env.MARKETING_FULL_SYNC_CRON  || '20 6-18/2 * * *';
const LIGHT_CRON = process.env.MARKETING_LIGHT_SYNC_CRON || '*/15 * * * *';
const ENABLED    = process.env.ENABLE_MARKETING_AUTO_SYNC !== 'false';

// Janela padrão pra puxar de campanhas e leads
const FULL_SINCE_DAYS  = Number(process.env.MARKETING_FULL_SYNC_SINCE_DAYS)  || 90;
const LIGHT_SINCE_DAYS = Number(process.env.MARKETING_LIGHT_SYNC_SINCE_DAYS) || 30;

// Pra evitar overlap se o job anterior ainda está rodando (full pode demorar).
let fullRunning = false;
let lightRunning = false;

// ────────────────────────────────────────────────────────────────────────────
// FULL — full sync (varre tudo)
// ────────────────────────────────────────────────────────────────────────────
async function runFullSync(opts = {}) {
    // opts:
    //   sinceDays        — janela de campanhas (default FULL_SINCE_DAYS)
    //   historicalDays   — janela do import histórico (default 7)
    //   reconcileLimit   — limite de reconciliação CV (default 100)
    //   adsAllStatuses   — true → sync ads de TODAS campanhas (não só ATIVAS)
    //                      Útil pra "Sincronizar tudo" manual.
    if (fullRunning) {
        console.warn('⏭️  [marketing-full-sync] anterior ainda rodando — pulando esta execução.');
        return { skipped: true, reason: 'Outro full sync já está em andamento.' };
    }
    fullRunning = true;
    const startedAt = Date.now();
    const sinceDays      = opts.sinceDays      ?? FULL_SINCE_DAYS;
    const historicalDays = opts.historicalDays ?? 7;
    const reconcileLimit = opts.reconcileLimit ?? 100;
    const adsAllStatuses = !!opts.adsAllStatuses;
    console.log(`🔁 [marketing-full-sync] iniciando varredura completa Meta (${sinceDays}d${adsAllStatuses ? ', todas campanhas' : ', só ativas'})...`);

    const summary = {
        forms: null, campaigns: null, ads: null,
        backfill: null, historical: null, reconciliation: null, errors: [],
    };

    // 1) Forms (Meta Lead Forms)
    try {
        summary.forms = await MetaLeadFormService.syncFromMeta();
        console.log(`✅ [marketing-full-sync] forms: ${summary.forms.forms_total} (${summary.forms.forms_new} novos)`);
    } catch (e) {
        summary.errors.push({ step: 'forms', error: e.message });
        console.error(`❌ [marketing-full-sync] forms: ${e.message}`);
    }

    // 2) Campanhas (todas as contas)
    try {
        summary.campaigns = await MetaCampaignService.syncFromMeta({ sinceDays });
        console.log(`✅ [marketing-full-sync] campanhas: ${summary.campaigns.campaigns_total}`);
    } catch (e) {
        summary.errors.push({ step: 'campaigns', error: e.message });
        console.error(`❌ [marketing-full-sync] campanhas: ${e.message}`);
    }

    // 3) Ads — por campanha. No cron, só ATIVAS (rate limit).
    //         No manual ("Sincronizar tudo"), pode pegar TODAS via adsAllStatuses.
    try {
        const where = adsAllStatuses ? {} : { effective_status: 'ACTIVE' };
        const targetCampaigns = await db.MetaCampaign.findAll({
            where, attributes: ['id', 'name'],
        });
        let adsOk = 0, adsErr = 0, adsTotal = 0;
        for (const c of targetCampaigns) {
            try {
                const r = await MetaAdService.syncForCampaign(c.id, { sinceDays });
                adsOk += 1;
                adsTotal += r.ads_total;
            } catch (e) {
                adsErr += 1;
                console.warn(`  ⚠️  [marketing-full-sync] ads campanha ${c.id}: ${e.message}`);
            }
        }
        summary.ads = { campaigns_processed: targetCampaigns.length, ads_total: adsTotal, errors: adsErr };
        console.log(`✅ [marketing-full-sync] ads: ${adsTotal} em ${adsOk}/${targetCampaigns.length} campanhas (${adsErr} erros)`);
    } catch (e) {
        summary.errors.push({ step: 'ads', error: e.message });
        console.error(`❌ [marketing-full-sync] ads: ${e.message}`);
    }

    // 4) Backfill ad → campaign (resolve históricos antigos com ad_id sem campaign_id,
    //    aproveitando o cache MetaAd que acabou de ser sincronizado no passo 3).
    try {
        summary.backfill = await LeadCampaignBackfillService.backfillCampaignsFromAds({ limit: 2000 });
        if (summary.backfill.scanned > 0) {
            console.log(`✅ [marketing-full-sync] backfill: ${summary.backfill.updated} resolvidos, ${summary.backfill.unresolved} sem ad em cache`);
        }
    } catch (e) {
        summary.errors.push({ step: 'backfill', error: e.message });
        console.warn(`⚠️  [marketing-full-sync] backfill (não-fatal): ${e.message}`);
    }

    // 5) Import histórico (janela configurável) — já usa lookup ad→campaign no insert
    try {
        summary.historical = await MetaHistoricalImportService.importHistorical({ sinceDays: historicalDays });
        console.log(`✅ [marketing-full-sync] histórico: ${summary.historical.inserted} novos, ${summary.historical.duplicates} dup`);
    } catch (e) {
        summary.errors.push({ step: 'historical', error: e.message });
        console.error(`❌ [marketing-full-sync] histórico: ${e.message}`);
    }

    // 6) Reconciliação com CV — best-effort
    try {
        summary.reconciliation = await CvReconciliationService.reconcileBatch({
            limit: reconcileLimit, channel: 'meta_lead_ads', status: 'historical',
        });
        console.log(`✅ [marketing-full-sync] CV-recon: ${summary.reconciliation.matched}/${summary.reconciliation.processed}`);
    } catch (e) {
        summary.errors.push({ step: 'reconciliation', error: e.message });
        console.warn(`⚠️  [marketing-full-sync] reconciliação CV (não-fatal): ${e.message}`);
    }

    const tookMs = Date.now() - startedAt;
    summary.duration_ms = tookMs;
    summary.duration_sec = +(tookMs / 1000).toFixed(1);
    console.log(`🏁 [marketing-full-sync] concluído em ${summary.duration_sec}s. Erros: ${summary.errors.length}.`);
    fullRunning = false;
    return summary;
}

// ────────────────────────────────────────────────────────────────────────────
// LIGHT — só insights de campanhas (rápido, dispara a cada 15min)
// ────────────────────────────────────────────────────────────────────────────
async function runLightSync() {
    if (lightRunning) return;          // silencioso — overlap pequeno é normal
    if (fullRunning) {
        // Full sync já está rolando — light fica de fora pra não competir por rate limit
        return;
    }
    lightRunning = true;
    const startedAt = Date.now();
    try {
        const result = await MetaCampaignService.syncFromMeta({ sinceDays: LIGHT_SINCE_DAYS });
        const tookSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`🔃 [marketing-light-sync] ${result.campaigns_total} campanha(s) em ${tookSec}s`);
    } catch (e) {
        console.warn(`⚠️  [marketing-light-sync] falhou: ${e.message}`);
    } finally {
        lightRunning = false;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────────
function start() {
    if (!ENABLED) {
        console.log('⏸️  [marketing-sync] desabilitado (ENABLE_MARKETING_AUTO_SYNC=false)');
        return;
    }

    if (!cron.validate(FULL_CRON)) {
        console.error(`❌ [marketing-sync] cron FULL inválido: ${FULL_CRON}`);
        return;
    }
    if (!cron.validate(LIGHT_CRON)) {
        console.error(`❌ [marketing-sync] cron LIGHT inválido: ${LIGHT_CRON}`);
        return;
    }

    cron.schedule(FULL_CRON,  runFullSync,  { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });
    cron.schedule(LIGHT_CRON, runLightSync, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });

    console.log(`📅 [marketing-sync] FULL  → "${FULL_CRON}" (TZ ${process.env.TIMEZONE || 'America/Sao_Paulo'})`);
    console.log(`📅 [marketing-sync] LIGHT → "${LIGHT_CRON}"`);
}

export default { start, runFullSync, runLightSync };
