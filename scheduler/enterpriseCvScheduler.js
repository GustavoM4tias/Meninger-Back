import cron from 'node-cron';
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';

const ctl = new EnterprisesSyncController();
const CRON = process.env.ENTERPRISE_CV_CRON_EXPRESSION || '0 11-22 * * *'; 

export default {
    start() {
        cron.schedule(CRON, async () => {
            console.log(`[CVCRM Empreendimentos] Iniciando deltaSync (${new Date().toISOString()})`);
            // fake res para não quebrar
            const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };
            await ctl.deltaSync({}, fakeRes);
        });
        console.log(`✅ Empreendimentos DELTA agendado: ${CRON}`);
    }
};
