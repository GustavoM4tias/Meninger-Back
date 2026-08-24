// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
// scheduler/leadCancelReasonScheduler.js
import CvLeadSyncController from '../services/bulkData/cv/bulkDataController.js';

const ctl = new CvLeadSyncController();
// Roda a cada 2 horas, levemente defasado do lead sync
const CRON_EXPR = process.env.LEAD_CANCEL_REASON_CRON_EXPRESSION || '15 */2 * * *';

const fakeRes = { send: () => {}, status: () => ({ send: () => {} }) };

export async function run() {
    await ctl.cancelReasonSync({}, fakeRes);
}

export default { run, cronPadrao: CRON_EXPR, bootstrapDelayMs: 0 };
