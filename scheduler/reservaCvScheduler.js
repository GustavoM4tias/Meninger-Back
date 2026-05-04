// src/scheduler/reservaCvScheduler.js
// Cron de delta de reservas — a cada 20 min. Status muda rápido (entrou em repasse,
// virou venda, distrato, etc) por isso é mais agressivo que precadastro/lead.
import cron from 'node-cron';
import CvReservasSyncController from '../controllers/cv/reservasSyncController.js';

const ctl = new CvReservasSyncController();
const CRON_EXPR = process.env.RESERVA_CV_CRON_EXPRESSION || '*/20 * * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start() {
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CVCRM Reservas Sync] tick ${new Date().toISOString()}`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ CVCRM Reservas agendado: ${CRON_EXPR} (${TZ})`);
    }
};
