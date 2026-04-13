import cron from 'node-cron';
import PriceTableSyncService from '../services/bulkData/cv/PriceTableSyncService.js';
import RealtorSyncService from '../services/bulkData/cv/RealtorSyncService.js';
import CorrespondentSyncService from '../services/bulkData/cv/CorrespondentSyncService.js';

// Padrão: uma vez por dia às 6h (tabelas de preço mudam pouco)
// Pode ser sobrescrito com CV_EXTRAS_CRON_EXPRESSION
const CRON = process.env.CV_EXTRAS_CRON_EXPRESSION || '0 6 * * *';

export default {
    start() {
        cron.schedule(CRON, async () => {
            console.log(`[CV Extras] Iniciando sync (${new Date().toISOString()})`);
            try {
                const ptSvc = new PriceTableSyncService();
                await ptSvc.syncAll();
            } catch (e) {
                console.error('[CV Extras] Erro PriceTable sync:', e?.message || e);
            }

            try {
                const rlSvc = new RealtorSyncService();
                await rlSvc.syncAll();
            } catch (e) {
                console.error('[CV Extras] Erro Realtor sync:', e?.message || e);
            }

            try {
                const crSvc = new CorrespondentSyncService();
                await crSvc.syncAll();
            } catch (e) {
                console.error('[CV Extras] Erro Correspondent sync:', e?.message || e);
            }

            console.log(`[CV Extras] Sync concluído (${new Date().toISOString()})`);
        });

        console.log(`✅ CV Extras (tabelas/imobiliárias/correspondentes) agendado: ${CRON}`);
    }
};
