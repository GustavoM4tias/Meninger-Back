// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
import cron from 'node-cron';
import PriceTableSyncService from '../services/bulkData/cv/PriceTableSyncService.js';
import RealtorSyncService from '../services/bulkData/cv/RealtorSyncService.js';
import CorrespondentSyncService from '../services/bulkData/cv/CorrespondentSyncService.js';

// Padrão: uma vez por dia às 6h (tabelas de preço mudam pouco)
// Pode ser sobrescrito com CV_EXTRAS_CRON_EXPRESSION
const CRON = process.env.CV_EXTRAS_CRON_EXPRESSION || '0 6 * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON;
        const task = cron.schedule(expr, async () => {
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
        }, { timezone: TZ });

        console.log(`✅ CV Extras (tabelas/imobiliárias/correspondentes) agendado: ${expr} (${TZ})`);
        return task;
    }
};
