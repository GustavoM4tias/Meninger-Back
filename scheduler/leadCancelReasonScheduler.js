// scheduler/leadCancelReasonScheduler.js
import cron from 'node-cron';
import CvLeadSyncController from '../services/bulkData/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
// Roda a cada 2 horas, levemente defasado do lead sync
const CRON_EXPR = process.env.LEAD_CANCEL_REASON_CRON_EXPRESSION || '15 */2 * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start() {
        const fakeRes = { send: () => {}, status: () => ({ send: () => {} }) };

        // 1ª passada ao subir
        ctl.cancelReasonSync({}, fakeRes).catch(e =>
            console.error('[CancelReason Scheduler] erro no bootstrap:', e?.message || e)
        );

        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CancelReason Scheduler] Iniciando delta (${new Date().toISOString()})`);
            await ctl.cancelReasonSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ Lead Cancel Reason agendado: ${CRON_EXPR} (${TZ})`);
    }
};
