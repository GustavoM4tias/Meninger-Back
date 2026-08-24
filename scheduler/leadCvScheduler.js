// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
// src/scheduler/leadCvScheduler.js
import cron from 'node-cron';
import CvLeadSyncController from '../services/bulkData/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
const CRON_EXPR = process.env.LEAD_CV_CRON_EXPRESSION || '*/30 * * * *'; // a cada 30min
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON_EXPR;
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        // 1ª passada ao subir (cobre janelas perdidas em restarts)
        if (bootstrap) ctl.deltaSync({}, fakeRes).catch(e =>
            console.error('[CVCRM Leads Sync] erro no bootstrap:', e?.message || e)
        );

        const task = cron.schedule(expr, async () => {
            console.log(`[CVCRM Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ CVCRM Leads Sync agendado: ${expr} (${TZ})`);
        return task;
    }
};
