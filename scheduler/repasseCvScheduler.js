// src/scheduler/repasseCvScheduler.js
import cron from 'node-cron';
import CvRepassesSyncController from '../controllers/cv/repassesSyncController.js';

const ctl = new CvRepassesSyncController();
const CRON_EXPR = process.env.REPASSE_CV_CRON_EXPRESSION || '*/20 * * * *';

export default {
    start() {
        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CVCRM Repasses Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };
            await ctl.deltaSync({}, fakeRes);
        });
        console.log(`✅ CVCRM Repasses Sync agendado: ${CRON_EXPR}`);
    }
};
