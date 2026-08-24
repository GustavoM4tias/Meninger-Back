// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
// scheduler/reservaCvSweepScheduler.js
//
// Cron DIÁRIO de varredura ID-a-ID das reservas.
// Garante captura de drift "ativa → terminal" (Cancelada/Vencida/Distrato)
// que a listing API do CV oculta. Pula IDs já em cv_reserva_id_dead, então
// o custo decresce ao longo do tempo (~5 min em regime estável).
//
// Default: 04:00 todo dia (America/Sao_Paulo).
// Habilitar via env: ENABLE_CV_RESERVA_SWEEP_SCHEDULE=true
import CvReservasSyncController from '../controllers/cv/reservasSyncController.js';

const ctl = new CvReservasSyncController();
const CRON_EXPR = process.env.RESERVA_CV_SWEEP_CRON_EXPRESSION || '0 4 * * *';

const fakeReq = { body: {} };
const fakeRes = { json: () => { }, status: () => ({ json: () => { }, send: () => { } }), send: () => { } };

export async function run() {
    await ctl.fullSweep(fakeReq, fakeRes);
}

export default { run, cronPadrao: CRON_EXPR };
