// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
// src/scheduler/repasseCvScheduler.js
import CvRepassesSyncController from '../controllers/cv/repassesSyncController.js';

const ctl = new CvRepassesSyncController();
const CRON_EXPR = process.env.REPASSE_CV_CRON_EXPRESSION || '*/20 * * * *';

const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };

export async function run() {
    await ctl.deltaSync({}, fakeRes);
}

export default { run, cronPadrao: CRON_EXPR, bootstrapDelayMs: 0 };
