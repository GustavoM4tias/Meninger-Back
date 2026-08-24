// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
// src/scheduler/reservaCvScheduler.js
// Cron de delta de reservas — a cada 20 min. Status muda rápido (entrou em repasse,
// virou venda, distrato, etc) por isso é mais agressivo que precadastro/lead.
import cron from 'node-cron';
import CvReservasSyncController from '../controllers/cv/reservasSyncController.js';

const ctl = new CvReservasSyncController();
const CRON_EXPR = process.env.RESERVA_CV_CRON_EXPRESSION || '*/20 * * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON_EXPR;
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

        const task = cron.schedule(expr, async () => {
            console.log(`[CVCRM Reservas Sync] tick ${new Date().toISOString()}`);
            await ctl.deltaSync({}, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ CVCRM Reservas agendado: ${expr} (${TZ})`);
        return task;
    }
};
