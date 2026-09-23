// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
import EnterprisesSyncController from '../controllers/cv/enterprisesSyncController.js';
import { criarResposta, exigirSucesso } from '../services/cv/fakeRes.js';
import { limparMarcasSoltas } from '../services/cv/unitStockService.js';

const ctl = new EnterprisesSyncController();
// Hora cheia, das 11h às 22h (horário comercial BR)
const CRON = process.env.ENTERPRISE_CV_CRON_EXPRESSION || '0 11-22 * * *';

export async function run() {
    const { res, estado } = criarResposta();
    await ctl.deltaSync({}, res);

    // Logo depois de trazer a situacao nova: a marca de "estoque comercial
    // segurado" morre junto com o bloqueio. Sem esta limpeza, unidade vendida
    // ou liberada continuaria contando como estoque e o numero cresceria
    // sozinho. Falhar aqui nao invalida o sync.
    await limparMarcasSoltas().catch((err) =>
        console.warn('[Empreendimentos] limpeza de marcas de estoque falhou:', err.message));

    exigirSucesso(estado);
}

export default { run, cronPadrao: CRON, bootstrapDelayMs: 0 };
