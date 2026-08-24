// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
// scheduler/correspondentCvScheduler.js
//
// Mantém o espelho de correspondentes em dia sem ninguém clicar em sincronizar.
// O sync faz três coisas: atualiza os usuários, PODA os excluídos no CV (senão
// fica fantasma na tela) e materializa as empresas com nome no cadastro do
// Office.
//
// A cada 30 min por padrão: o volume é pequeno (~125 usuários, 1 chamada
// paginada) e o cadastro de correspondente muda ao longo do dia.
import correspondentService from '../services/correspondent/correspondentService.js';

const CRON_EXPR = process.env.CORRESPONDENT_CV_CRON_EXPRESSION || '*/30 * * * *';

async function rodar(origem) {
    try {
        const total = await correspondentService.sincronizarEspelho();
        console.log(`[Correspondentes] sync ${origem}: ${total} usuário(s) no CV`);
    } catch (err) {
        // Nunca derruba o boot nem o cron: o CV cai com alguma frequência.
        console.warn('[Correspondentes] sync falhou:', err.message);
    }
}

export async function run() {
    await rodar('execução');
}

// Primeira carga um pouco depois do boot, para a tela não abrir vazia quando as
// tabelas acabaram de ser criadas.
export default { run, cronPadrao: CRON_EXPR, bootstrapDelayMs: 45_000 };
