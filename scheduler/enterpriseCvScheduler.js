// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
import cron from 'node-cron';
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';

const ctl = new EnterprisesSyncController();
// Hora cheia, das 11h às 22h (horário comercial BR)
const CRON = process.env.ENTERPRISE_CV_CRON_EXPRESSION || '0 11-22 * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON;
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        // 1ª passada ao subir
        if (bootstrap) ctl.deltaSync({}, fakeRes).catch(e =>
            console.error('[CVCRM Empreendimentos] erro no bootstrap:', e?.message || e)
        );

        const task = cron.schedule(expr, async () => {
            console.log(`[CVCRM Empreendimentos] Iniciando deltaSync (${new Date().toISOString()})`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ Empreendimentos DELTA agendado: ${expr} (${TZ})`);
        return task;
    }
};
