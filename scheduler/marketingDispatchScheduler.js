// scheduler/marketingDispatchScheduler.js
//
// Re-tenta o despacho de inbound_leads que falharam de forma transitória
// (status 'failed' com next_retry_at vencido) e recupera leads presos em
// 'dispatching' (o processo caiu no meio do POST).
//
// Leads em dead-letter (failed + next_retry_at = null) NÃO são re-tentados —
// aguardam ação manual (o alerta já foi disparado no momento do dead-letter).
//
// Desligar via env: ENABLE_MARKETING_CAPTURE=false

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import { dispatchLead } from '../services/marketing/CvLeadDispatchService.js';
import { recordLeadEvent } from '../services/marketing/leadEventLog.js';

const CRON_EXP = process.env.MARKETING_DISPATCH_CRON || '*/3 * * * *'; // a cada 3 min
const STUCK_DISPATCHING_MIN = 10;   // 'dispatching' há mais que isso = preso
const BATCH = 50;

async function runCycle() {
    const { InboundLead } = db;

    // 1) Recupera leads presos em 'dispatching' (crash no meio do POST).
    const stuckCutoff = new Date(Date.now() - STUCK_DISPATCHING_MIN * 60 * 1000);
    const stuck = await InboundLead.findAll({
        where: { status: 'dispatching', last_dispatch_at: { [Op.lt]: stuckCutoff } },
        attributes: ['id'],
    });

    // 2) 'failed' com next_retry_at vencido. Dead-letter tem next_retry_at = null,
    //    e (NULL <= now) é NULL em SQL — logo não entra no resultado.
    const due = await InboundLead.findAll({
        where: { status: 'failed', next_retry_at: { [Op.lte]: new Date() } },
        order: [['next_retry_at', 'ASC']],
        limit: BATCH,
        attributes: ['id'],
    });

    if (!stuck.length && !due.length) return;
    console.log(`📤 [MarketingDispatch] ${due.length} a re-tentar · ${stuck.length} preso(s) recuperado(s).`);

    for (const s of stuck) {
        await recordLeadEvent({
            leadId: s.id, type: 'recovered_stuck', actor: 'scheduler',
            message: `Lead preso em "dispatching" há mais de ${STUCK_DISPATCHING_MIN} min — re-despachado.`,
        });
    }

    // Leads presos ('dispatching') também são despacháveis pelo service.
    for (const lead of [...stuck, ...due]) {
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
