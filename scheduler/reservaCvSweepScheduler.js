// Assinatura padronizada em 2026-08-24: o horário e o liga/desliga destes
// crons passaram a morar em cv_sync_jobs, editáveis em CV CRM > Configurações.
// `start({ expression, bootstrap })` recebe o horário vindo do banco e devolve
// a task, para o gerente (services/cv/cvCronManager.js) conseguir PARAR e
// reagendar sem reiniciar o processo. `bootstrap:false` evita disparar a carga
// inicial quando o admin só salvou uma configuração na tela.
// scheduler/reservaCvSweepScheduler.js
//
// Cron DIÁRIO de varredura ID-a-ID das reservas.
// Garante captura de drift "ativa → terminal" (Cancelada/Vencida/Distrato)
// que a listing API do CV oculta. Pula IDs já em cv_reserva_id_dead, então
// o custo decresce ao longo do tempo (~5 min em regime estável).
//
// Default: 04:00 todo dia (America/Sao_Paulo).
// Habilitar via env: ENABLE_CV_RESERVA_SWEEP_SCHEDULE=true
import cron from 'node-cron';
import CvReservasSyncController from '../controllers/cv/reservasSyncController.js';

const ctl = new CvReservasSyncController();
const CRON_EXPR = process.env.RESERVA_CV_SWEEP_CRON_EXPRESSION || '0 4 * * *';
const TZ = 'America/Sao_Paulo';

export default {
    start({ expression, bootstrap = true } = {}) {
        const expr = expression || CRON_EXPR;
        const fakeReq = { body: {} };
        const fakeRes = { json: () => { }, status: () => ({ json: () => { }, send: () => { } }), send: () => { } };

        const task = cron.schedule(expr, async () => {
            console.log(`[CVCRM Reservas SWEEP] tick ${new Date().toISOString()}`);
            await ctl.fullSweep(fakeReq, fakeRes);
        }, { timezone: TZ });

        console.log(`✅ CVCRM Reservas SWEEP agendado: ${expr} (${TZ})`);
        return task;
    }
};
