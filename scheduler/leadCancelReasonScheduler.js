// scheduler/leadCancelReasonScheduler.js
import cron from 'node-cron';
import CvLeadSyncController from '../services/bulkData/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
// Roda a cada 2 horas, levemente defasado do lead sync
const CRON_EXPR = process.env.LEAD_CANCEL_REASON_CRON_EXPRESSION || '15 */2 * * *';

export default {
    start() {
        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CancelReason Scheduler] Iniciando delta (${new Date().toISOString()})`);
            const fakeRes = { send: () => {}, status: () => ({ send: () => {} }) };
            await ctl.cancelReasonSync({}, fakeRes);
        });
        console.log(`✅ Lead Cancel Reason agendado: ${CRON_EXPR}`);
    }
};
