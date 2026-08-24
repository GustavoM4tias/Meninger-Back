// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
// scheduler/precadastroCvScheduler.js
// Cron de delta de pré-cadastros — a cada 30 min (sem documentos, ~30s p/ 11k).
import CvPrecadastrosSyncController from '../controllers/cv/precadastrosSyncController.js';
import { criarResposta, exigirSucesso } from '../services/cv/fakeRes.js';

const ctl = new CvPrecadastrosSyncController();
const CRON_EXPR = process.env.PRECADASTRO_CV_CRON_EXPRESSION || '*/30 * * * *';

const fakeReq = { query: {}, body: {} };

export async function run() {
    const { res, estado } = criarResposta();
    await ctl.deltaSync(fakeReq, res);
    exigirSucesso(estado);
}

export default { run, cronPadrao: CRON_EXPR };
