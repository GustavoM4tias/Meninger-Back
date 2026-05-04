// src/scheduler/repasseCvScheduler.js
import cron from 'node-cron';
import CvRepassesSyncController from '../controllers/cv/repassesSyncController.js';

const ctl = new CvRepassesSyncController();
const CRON_EXPR = process.env.REPASSE_CV_CRON_EXPRESSION || '*/20 * * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start() {
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        // 1ª passada ao subir
        ctl.deltaSync({}, fakeRes).catch(e =>
            console.error('[CVCRM Repasses Sync] erro no bootstrap:', e?.message || e)
        );

        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CVCRM Repasses Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ CVCRM Repasses Sync agendado: ${CRON_EXPR} (${TZ})`);
    }
};
