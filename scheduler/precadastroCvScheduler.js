// scheduler/precadastroCvScheduler.js
// Cron de delta de pré-cadastros — a cada 30 min (sem documentos, ~30s p/ 11k).
import cron from 'node-cron';
import CvPrecadastrosSyncController from '../controllers/cv/precadastrosSyncController.js';

const ctl = new CvPrecadastrosSyncController();
const CRON_EXPR = process.env.PRECADASTRO_CV_CRON_EXPRESSION || '*/30 * * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start() {
        const fakeReq = { query: {}, body: {} };
        const fakeRes = { send: () => {}, status: () => ({ send: () => {} }) };

        cron.schedule(CRON_EXPR, async () => {
            console.log(`[CVCRM Precadastros Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync(fakeReq, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ Precadastros agendado — delta: ${CRON_EXPR} (${TZ})`);
    }
};
