// scheduler/marketingDispatchScheduler.js
//
// Re-tenta o despacho de inbound_leads que falharam de forma transitória
// (status 'failed' com next_retry_at vencido) e recupera leads presos em
// 'dispatching' (o processo caiu no meio do POST) ou órfãos em 'routed'
// (roteados/promovidos mas o processo caiu antes do POST).
//
// Leads em dead-letter (failed + next_retry_at = null) NÃO são re-tentados —
// aguardam ação manual (o alerta já foi disparado no momento do dead-letter).
//
// Desligar via env: ENABLE_MARKETING_CAPTURE=false

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import { dispatchLead } from '../services/marketing/CvLeadDispatchService.js';
import { retryPendingGraphFetches } from '../services/marketing/MetaLeadAdsService.js';
import { recordLeadEvent } from '../services/marketing/leadEventLog.js';
import MarketingConfigService from '../services/marketing/MarketingConfigService.js';

async function isShadowMode() {
    try {
        const cfg = await MarketingConfigService.getConfig();
        return cfg ? !!cfg.dry_run : (process.env.MARKETING_CAPTURE_DRY_RUN === 'true');
    } catch {
        return process.env.MARKETING_CAPTURE_DRY_RUN === 'true';
    }
}

const CRON_EXP = process.env.MARKETING_DISPATCH_CRON || '*/3 * * * *'; // a cada 3 min
const STUCK_DISPATCHING_MIN = 10;   // 'dispatching' há mais que isso = preso
const BATCH = 50;

async function runCycle() {
    const { InboundLead } = db;

    // 0) Re-tenta fetch na Graph API de stubs pendentes (webhook chegou mas a
    //    busca dos dados falhou — antes esses leads eram perdidos em silêncio).
    try {
        const refetched = await retryPendingGraphFetches({ limit: 20 });
        if (refetched > 0) console.log(`🔁 [MarketingDispatch] ${refetched} fetch(es) pendente(s) da Graph re-tentado(s).`);
    } catch (err) {
        console.error(`❌ [MarketingDispatch] retry de fetches pendentes: ${err.message}`);
    }

    // 1) Recupera leads presos em 'dispatching' (crash no meio do POST).
    const stuckCutoff = new Date(Date.now() - STUCK_DISPATCHING_MIN * 60 * 1000);
    const stuck = await InboundLead.findAll({
        where: { status: 'dispatching', last_dispatch_at: { [Op.lt]: stuckCutoff } },
        attributes: ['id'],
    });

    // 1b) 'routed' órfão: roteado ao vivo ou promovido pelo cutover, mas o
    //     processo caiu antes do POST. Fora do modo sombra, routed parado não
    //     é estado de espera válido — re-despacha. Na sombra, routed é a fila
    //     segurada de propósito: não mexe.
    let orphanRouted = [];
    if (!(await isShadowMode())) {
        orphanRouted = await InboundLead.findAll({
            where: { status: 'routed', updated_at: { [Op.lt]: stuckCutoff } },
            order: [['updated_at', 'ASC']],
            limit: BATCH,
            attributes: ['id'],
        });
    }

    // 2) 'failed' com next_retry_at vencido. Dead-letter tem next_retry_at = null,
    //    e (NULL <= now) é NULL em SQL — logo não entra no resultado.
    const due = await InboundLead.findAll({
        where: { status: 'failed', next_retry_at: { [Op.lte]: new Date() } },
        order: [['next_retry_at', 'ASC']],
        limit: BATCH,
        attributes: ['id'],
    });

    if (!stuck.length && !orphanRouted.length && !due.length) return;
    console.log(`📤 [MarketingDispatch] ${due.length} a re-tentar · ${stuck.length} preso(s) · ${orphanRouted.length} routed órfão(s).`);

    for (const s of stuck) {
        await recordLeadEvent({
            leadId: s.id, type: 'recovered_stuck', actor: 'scheduler',
            message: `Lead preso em "dispatching" há mais de ${STUCK_DISPATCHING_MIN} min — re-despachado.`,
        });
    }
    for (const o of orphanRouted) {
        await recordLeadEvent({
            leadId: o.id, type: 'recovered_stuck', actor: 'scheduler',
            message: `Lead órfão em "routed" há mais de ${STUCK_DISPATCHING_MIN} min — despacho retomado.`,
        });
    }

    // Leads presos ('dispatching') e routed órfãos também são despacháveis pelo service.
    for (const lead of [...stuck, ...orphanRouted, ...due]) {
        try {
            await dispatchLead(lead.id, { actor: 'scheduler' });
        } catch (err) {
            console.error(`❌ [MarketingDispatch] erro ao despachar lead ${lead.id}: ${err.message}`);
        }
    }
}

class MarketingDispatchScheduler {
    constructor() {
        this.task = null;
    }

    start() {
        if (this.task) this.task.stop();
        this.task = cron.schedule(CRON_EXP, () => { runCycle().catch(console.error); });
        console.log(`✅ MarketingDispatchScheduler configurado: ${CRON_EXP}`);

        // Roda uma vez ao iniciar (sem aguardar o primeiro ciclo).
        runCycle().catch(console.error);
    }

    stop() {
        if (this.task) this.task.stop();
        console.log('⛔ MarketingDispatchScheduler parado');
    }
}

export default new MarketingDispatchScheduler();
