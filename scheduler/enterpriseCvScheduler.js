import cron from 'node-cron';
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';

const ctl = new EnterprisesSyncController();
const TZ = 'America/Sao_Paulo';
const CRON_1 = process.env.ENTERPRISE_DELTA_AT_1 || '0 10 * * *';
const CRON_2 = process.env.ENTERPRISE_DELTA_AT_2 || '0 16 * * *';

export default {
    start() {
        cron.schedule(CRON_1, async () => {
            console.log(`[CVCRM Empreendimentos] Iniciando deltaSync (10h) ${new Date().toISOString()}`);
            const fakeRes = { json: () => { }, status: () => ({ json: () => { } }) };
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        cron.schedule(CRON_2, async () => {
            console.log(`[CVCRM Empreendimentos] Iniciando deltaSync (16h) ${new Date().toISOString()}`);
            const fakeRes = { json: () => { }, status: () => ({ json: () => { } }) };
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ Empreendimentos DELTA agendado: ${CRON_1} e ${CRON_2} (${TZ})`);
    }
};
