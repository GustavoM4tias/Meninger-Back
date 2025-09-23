// src/scheduler/leadCvScheduler.js
import cron from 'node-cron';
import CvLeadSyncController from '../controllers/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
const CRON_EXPR = process.env.LEAD_CV_CRON_EXPRESSION || '*/30 * * * *'; // a cada 30min

export default {
    start() {
        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CVCRM Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            // fake res para não quebrar
            const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };
            await ctl.deltaSync({}, fakeRes);
        });
        console.log(`✅ CVCRM Leads Sync agendado: ${CRON_EXPR}`);
    }
};
