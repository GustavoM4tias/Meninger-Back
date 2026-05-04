import cron from 'node-cron';
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';

const ctl = new EnterprisesSyncController();
// Hora cheia, das 11h às 22h (horário comercial BR)
const CRON = process.env.ENTERPRISE_CV_CRON_EXPRESSION || '0 11-22 * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start() {
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        // 1ª passada ao subir
        ctl.deltaSync({}, fakeRes).catch(e =>
            console.error('[CVCRM Empreendimentos] erro no bootstrap:', e?.message || e)
        );

        cron.schedule(CRON, async () => {
            console.log(`[CVCRM Empreendimentos] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ Empreendimentos DELTA agendado: ${CRON} (${TZ})`);
    }
};
