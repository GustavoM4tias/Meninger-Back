// scheduler/marketingSyncScheduler.js
//
// 2 jobs que mantêm os dados Meta atualizados automaticamente:
//
//   FULL — varre tudo (forms + campanhas + ads + leads históricos).
//          Cron padrão: 06:20 → 22:20 a cada 2h ("20 6-22/2 * * *") = 9x/dia.
//
//   LIGHT — só refresca insights de campanhas (rápido).
//          Cron padrão: 10 em 10 minutos ("*/10 * * * *").
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
import MetaInsightsDailyService from '../services/marketing/MetaInsightsDailyService.js';
import CvBindingHealthService from '../services/marketing/CvBindingHealthService.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';
import LeadCampaignBackfillService from '../services/marketing/LeadCampaignBackfillService.js';
import MarketingConfigService from '../services/marketing/MarketingConfigService.js';
import CvLeadQueueService from '../services/marketing/CvLeadQueueService.js';
import MetaCampaignsTokenService from '../services/meta/MetaCampaignsTokenService.js';

const FULL_CRON  = process.env.MARKETING_FULL_SYNC_CRON  || '20 6-22/2 * * *';
const LIGHT_CRON = process.env.MARKETING_LIGHT_SYNC_CRON || '*/10 * * * *';
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
    const adsAllStatuses = !!opts.adsAllStatuses;
    console.log(`🔁 [marketing-full-sync] iniciando varredura completa Meta (${sinceDays}d${adsAllStatuses ? ', todas campanhas' : ', só ativas'})...`);

    const summary = {
        forms: null, campaigns: null, ads: null,
        backfill: null, historical: null, filas: null, errors: [],
    };

    // 0a) Filas de distribuição do CV. Vem antes de tudo porque o despacho de
    //     lead decide destino a partir desse espelho: fila que mudou no CV e não
    //     chegou aqui vira lead represado, sem aviso. O mapa empreendimento ->
    //     fila NÃO é recalculado aqui: ele é por id e declarado por gente.
    try {
        const { sync } = await CvLeadQueueService.refresh();
        summary.filas = sync;
        console.log(`✅ [marketing-full-sync] filas: ${sync.total} (${sync.novas} novas, ${sync.sumiram} sumiram do CV)`);
    } catch (e) {
        summary.errors.push({ step: 'filas', error: e.message });
        console.error(`❌ [marketing-full-sync] filas: ${e.message}`);
    }

    // 0) Token de gestão de campanhas: renova se perto de expirar + alerta se não
    //    der. No-op se não configurado (usa fallback do System User). Não bloqueia.
    try {
        await MetaCampaignsTokenService.maybeRefreshAndAlert();
    } catch (e) {
        console.warn(`⚠️  [marketing-full-sync] refresh do token de campanhas: ${e.message}`);
    }

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

    // 4b) Série diária (relatórios por período) — 3 níveis, janela de 35 dias.
    //     A Meta corrige números até ~28d pra trás; 35d re-grava com folga.
    //     Backfills maiores (90/365d) são manuais via POST /meta-report/backfill.
    try {
        summary.insights_daily = await MetaInsightsDailyService.syncDaily({
            sinceDays: 35, levels: ['campaign', 'adset', 'ad'],
        });
        console.log(`✅ [marketing-full-sync] série diária: ${summary.insights_daily.rows_written} linhas (${summary.insights_daily.errors.length} erros)`);
    } catch (e) {
        summary.errors.push({ step: 'insights_daily', error: e.message });
        console.warn(`⚠️  [marketing-full-sync] série diária (não-fatal): ${e.message}`);
    }

    // 5) Import histórico (janela configurável) — já usa lookup ad→campaign no insert
    try {
        summary.historical = await MetaHistoricalImportService.importHistorical({ sinceDays: historicalDays });
        console.log(`✅ [marketing-full-sync] histórico: ${summary.historical.inserted} novos, ${summary.historical.duplicates} dup`);
    } catch (e) {
        summary.errors.push({ step: 'historical', error: e.message });
        console.error(`❌ [marketing-full-sync] histórico: ${e.message}`);
    }

    // 6) Alerta de vínculo: campanhas sem binding represando leads (throttle ~20h).
    try {
        await alertMissingBindings();
    } catch (e) {
        console.warn(`⚠️  [marketing-full-sync] alerta de vínculo (não-fatal): ${e.message}`);
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
        // Frescor da série diária no nível campanha (KPIs/gráfico do relatório).
        // Só 3 dias — barato; adset/ad ficam pro FULL (rate limit).
        let dailyRows = 0;
        try {
            const daily = await MetaInsightsDailyService.syncDaily({ sinceDays: 3, levels: ['campaign'] });
            dailyRows = daily.rows_written;
        } catch (e) {
            console.warn(`⚠️  [marketing-light-sync] série diária: ${e.message}`);
        }
        const tookSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`🔃 [marketing-light-sync] ${result.campaigns_total} campanha(s), ${dailyRows} linhas diárias em ${tookSec}s`);
    } catch (e) {
        console.warn(`⚠️  [marketing-light-sync] falhou: ${e.message}`);
    } finally {
        lightRunning = false;
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Alerta: campanhas sem vínculo represando leads
// ────────────────────────────────────────────────────────────────────────────
// Avisa os admins quando há campanhas Meta sem vínculo com o CV acumulando leads
// em 'held' — esses leads não chegam ao CRM até alguém vincular. Throttle de ~20h
// pra alertar no máximo 1x/dia (o FULL sync roda ~9x/dia).
let _lastBindingAlertAt = 0;
const BINDING_ALERT_THROTTLE_MS = 20 * 60 * 60 * 1000;

async function alertMissingBindings() {
    const signal = await CvBindingHealthService.getAlertSignal();
    if (!signal.should_alert) return;

    const now = Date.now();
    if (now - _lastBindingAlertAt < BINDING_ALERT_THROTTLE_MS) return;
    _lastBindingAlertAt = now;

    const userIds = await MarketingConfigService.getAlertRecipients();
    if (!userIds.length) return;

    // Duas situações no mesmo aviso: leads JÁ represados (urgente) e campanha
    // de lead ativa sem vínculo (cobrar antes do primeiro lead — foi a falta
    // desse aviso que deixou leads de Avaré irem pra Ibitinga em ago/2026).
    const parts = [];
    if (signal.leads_at_risk > 0) {
        const topList = signal.top.map(t => `• ${t.name} (${t.held} lead${t.held === 1 ? '' : 's'})`).join('\n');
        parts.push(`Leads represados que não chegam ao CV por falta de vínculo:\n${topList}`);
    }
    if (signal.active_unbound_count > 0) {
        const topList = signal.active_unbound_top.map(n => `• ${n}`).join('\n');
        parts.push(`Campanha(s) de lead ATIVA(s) sem vínculo — vincule antes que os leads cheguem:\n${topList}`);
    }
    const title = signal.leads_at_risk > 0
        ? `${signal.unbound_count} campanha(s) sem vínculo represando ${signal.leads_at_risk} lead(s)`
        : `${signal.active_unbound_count} campanha(s) de lead ativa(s) sem vínculo com o CV`;

    await NotificationService.notify({
        type: NotificationType.LEAD_BINDING_MISSING,
        recipients: { users: userIds },
        title,
        body: `${parts.join('\n\n')}\n\nVincule na Central Meta › Vínculos CV.`,
        link: '/meta?tab=vinculos',
        importance: 8,
    });
    console.warn(`🔔 [marketing-full-sync] alerta de vínculo enviado: ${signal.unbound_count} represando, ${signal.active_unbound_count} ativa(s) sem vínculo.`);
}

// ────────────────────────────────────────────────────────────────────────────
// Auto-backfill da série diária (1x na vida)
// ────────────────────────────────────────────────────────────────────────────
// Na primeira subida com a feature, `meta_insights_daily` está VAZIA → o
// relatório apareceria vazio até alguém clicar em "Preencher série diária".
// Se a tabela estiver vazia, disparamos em background UMA carga LEVE (só nível
// CAMPANHA, 30 dias) — o suficiente pros KPIs/gráfico do relatório funcionarem
// já no primeiro boot, SEM o peso do nível de anúncio (que gera muitos
// registros e podia dar pico de memória/DB logo após o deploy).
// Os níveis conjunto/anúncio e janelas maiores ficam pro FULL sync (que roda
// aos poucos) ou pro botão manual "Preencher série diária". Gated na tabela
// vazia: roda uma única vez; nas próximas subidas é no-op instantâneo.
const AUTO_BACKFILL_DAYS = Number(process.env.MARKETING_DAILY_BACKFILL_DAYS) || 30;

async function backfillDailyIfEmpty() {
    try {
        const count = await db.MetaInsightDaily.count();
        if (count > 0) return;   // já populada — nada a fazer
        console.log(`🌱 [insights-daily] tabela vazia → backfill inicial LEVE de ${AUTO_BACKFILL_DAYS}d (só campanha) em background...`);
        // NÃO await — não bloqueia o boot. Erros são só logados.
        MetaInsightsDailyService.syncDaily({ sinceDays: AUTO_BACKFILL_DAYS, levels: ['campaign'] })
            .then(r => console.log(`🌱 [insights-daily] backfill inicial concluído: ${r.rows_written} linhas (${r.errors.length} erros)`))
            .catch(e => console.warn(`⚠️  [insights-daily] backfill inicial falhou: ${e.message}`));
    } catch (e) {
        console.warn(`⚠️  [insights-daily] checagem de backfill inicial falhou: ${e.message}`);
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

    // Popula a série diária na primeira subida (1x). Background, não bloqueia boot.
    backfillDailyIfEmpty();
}

export default { start, runFullSync, runLightSync };
