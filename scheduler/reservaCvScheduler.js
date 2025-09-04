// src/scheduler/reservaCvScheduler.js
import cron from 'node-cron';
import CvReservasSyncController from '../controllers/cv/reservasSyncController.js';

const ctl = new CvReservasSyncController();
const CRON_EXPR = process.env.RESERVA_CV_CRON_EXPRESSION || '*/20 * * * *'; // a cada 20min

export default {
    start() {
        // 1ª passada ao subir (cobre janelas perdidas)
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };
        ctl.deltaSync({}, fakeRes);

        // Agendado
        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CVCRM Reservas Sync] tick ${new Date().toISOString()}`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: 'America/Sao_Paulo' });

        console.log(`✅ CVCRM Reservas agendado: ${CRON_EXPR}`);
    }
};
