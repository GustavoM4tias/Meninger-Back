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
async function runFullSync() {
    if (fullRunning) {
        console.warn('⏭️  [marketing-full-sync] anterior ainda rodando — pulando esta execução.');
        return;
    }
    fullRunning = true;
    const startedAt = Date.now();
    console.log('🔁 [marketing-full-sync] iniciando varredura completa Meta...');

    const summary = {
        forms: null, campaigns: null, ads: null,
        historical: null, reconciliation: null, errors: [],
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
        summary.campaigns = await MetaCampaignService.syncFromMeta({ sinceDays: FULL_SINCE_DAYS });
        console.log(`✅ [marketing-full-sync] campanhas: ${summary.campaigns.campaigns_total}`);
    } catch (e) {
        summary.errors.push({ step: 'campaigns', error: e.message });
        console.error(`❌ [marketing-full-sync] campanhas: ${e.message}`);
    }

    // 3) Ads — por campanha. Pra não estourar rate limit, só ATIVAS aqui.
    try {
        const activeCampaigns = await db.MetaCampaign.findAll({
            where: { effective_status: 'ACTIVE' },
            attributes: ['id', 'name'],
        });
        let adsOk = 0, adsErr = 0, adsTotal = 0;
        for (const c of activeCampaigns) {
            try {
                const r = await MetaAdService.syncForCampaign(c.id, { sinceDays: FULL_SINCE_DAYS });
                adsOk += 1;
                adsTotal += r.ads_total;
            } catch (e) {
                adsErr += 1;
                console.warn(`  ⚠️  [marketing-full-sync] ads campanha ${c.id}: ${e.message}`);
            }
        }
        summary.ads = { campaigns_processed: activeCampaigns.length, ads_total: adsTotal, errors: adsErr };
        console.log(`✅ [marketing-full-sync] ads: ${adsTotal} em ${adsOk}/${activeCampaigns.length} campanhas (${adsErr} erros)`);
    } catch (e) {
        summary.errors.push({ step: 'ads', error: e.message });
        console.error(`❌ [marketing-full-sync] ads: ${e.message}`);
    }

    // 4) Import histórico — janela curta no auto-sync (últimos 7 dias) pra não
    // estourar tempo. Pra puxar 90d, o usuário usa o botão "Importar histórico".
    try {
        summary.historical = await MetaHistoricalImportService.importHistorical({ sinceDays: 7 });
        console.log(`✅ [marketing-full-sync] histórico: ${summary.historical.inserted} novos, ${summary.historical.duplicates} dup`);
    } catch (e) {
        summary.errors.push({ step: 'historical', error: e.message });
        console.error(`❌ [marketing-full-sync] histórico: ${e.message}`);
    }

    // 5) Reconciliação com CV — best-effort, ignora se CV falhar.
    try {
        summary.reconciliation = await CvReconciliationService.reconcileBatch({
            limit: 100, channel: 'meta_lead_ads', status: 'historical',
        });
        console.log(`✅ [marketing-full-sync] CV-recon: ${summary.reconciliation.matched}/${summary.reconciliation.processed}`);
    } catch (e) {
        summary.errors.push({ step: 'reconciliation', error: e.message });
        console.warn(`⚠️  [marketing-full-sync] reconciliação CV (não-fatal): ${e.message}`);
    }

    const tookSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`🏁 [marketing-full-sync] concluído em ${tookSec}s. Erros: ${summary.errors.length}.`);
    fullRunning = false;
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
