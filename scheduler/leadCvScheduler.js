// src/scheduler/leadCvScheduler.js
import cron from 'node-cron';
import CvLeadSyncController from '../services/bulkData/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
const CRON_EXPR = process.env.LEAD_CV_CRON_EXPRESSION || '*/30 * * * *'; // a cada 30min
const TZ = 'America/Sao_Paulo';

export default {
    start() {
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        // 1ª passada ao subir (cobre janelas perdidas em restarts)
        ctl.deltaSync({}, fakeRes).catch(e =>
            console.error('[CVCRM Leads Sync] erro no bootstrap:', e?.message || e)
        );

        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CVCRM Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ CVCRM Leads Sync agendado: ${CRON_EXPR} (${TZ})`);
    }
};
