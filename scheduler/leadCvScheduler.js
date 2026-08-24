// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
// src/scheduler/leadCvScheduler.js
import CvLeadSyncController from '../services/bulkData/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
const CRON_EXPR = process.env.LEAD_CV_CRON_EXPRESSION || '*/30 * * * *'; // a cada 30min

const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

export async function run() {
    await ctl.deltaSync({}, fakeRes);
}

// bootstrapDelayMs 0: roda ao subir, cobrindo a janela perdida no restart.
export default { run, cronPadrao: CRON_EXPR, bootstrapDelayMs: 0 };
