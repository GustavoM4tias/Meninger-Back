// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
// scheduler/precadastroCvScheduler.js
// Cron de delta de pré-cadastros — a cada 30 min (sem documentos, ~30s p/ 11k).
import cron from 'node-cron';
import CvPrecadastrosSyncController from '../controllers/cv/precadastrosSyncController.js';

const ctl = new CvPrecadastrosSyncController();
const CRON_EXPR = process.env.PRECADASTRO_CV_CRON_EXPRESSION || '*/30 * * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON_EXPR;
        const fakeReq = { query: {}, body: {} };
        const fakeRes = { send: () => {}, status: () => ({ send: () => {} }) };

        const task = cron.schedule(expr, async () => {
            console.log(`[CVCRM Precadastros Sync] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync(fakeReq, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ Precadastros agendado — delta: ${expr} (${TZ})`);
        return task;
    }
};
