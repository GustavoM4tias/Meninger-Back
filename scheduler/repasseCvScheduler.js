// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
// src/scheduler/repasseCvScheduler.js
import cron from 'node-cron';
import CvRepassesSyncController from '../controllers/cv/repassesSyncController.js';

const ctl = new CvRepassesSyncController();
const CRON_EXPR = process.env.REPASSE_CV_CRON_EXPRESSION || '*/20 * * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON_EXPR;
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        // 1ª passada ao subir
        if (bootstrap) ctl.deltaSync({}, fakeRes).catch(e =>
            console.error('[CVCRM Repasses Sync] erro no bootstrap:', e?.message || e)
        );

        const task = cron.schedule(expr, async () => {
            console.log(`[CVCRM Repasses Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ CVCRM Repasses Sync agendado: ${expr} (${TZ})`);
        return task;
    }
};
