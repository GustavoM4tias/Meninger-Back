// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
// scheduler/leadCancelReasonScheduler.js
import cron from 'node-cron';
import CvLeadSyncController from '../services/bulkData/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
// Roda a cada 2 horas, levemente defasado do lead sync
const CRON_EXPR = process.env.LEAD_CANCEL_REASON_CRON_EXPRESSION || '15 */2 * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON_EXPR;
        const fakeRes = { send: () => {}, status: () => ({ send: () => {} }) };

        // 1ª passada ao subir
        if (bootstrap) ctl.cancelReasonSync({}, fakeRes).catch(e =>
            console.error('[CancelReason Scheduler] erro no bootstrap:', e?.message || e)
        );

        const task = cron.schedule(expr, async () => {
            console.log(`[CancelReason Scheduler] Iniciando delta (${new Date().toISOString()})`);
            await ctl.cancelReasonSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ Lead Cancel Reason agendado: ${expr} (${TZ})`);
        return task;
    }
};
