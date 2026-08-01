// scheduler/correspondentCvScheduler.js
//
// Mantém o espelho de correspondentes em dia sem ninguém clicar em sincronizar.
// O sync faz três coisas: atualiza os usuários, PODA os excluídos no CV (senão
// fica fantasma na tela) e materializa as empresas com nome no cadastro do
// Office.
//
// A cada 30 min por padrão: o volume é pequeno (~125 usuários, 1 chamada
// paginada) e o cadastro de correspondente muda ao longo do dia.
import cron from 'node-cron';
import correspondentService from '../services/correspondent/correspondentService.js';

const CRON_EXPR = process.env.CORRESPONDENT_CV_CRON_EXPRESSION || '*/30 * * * *';
const TZ = 'America/Sao_Paulo';

async function rodar(origem) {
    try {
        const total = await correspondentService.sincronizarEspelho();
        console.log(`[Correspondentes] sync ${origem}: ${total} usuário(s) no CV`);
    } catch (err) {
        // Nunca derruba o boot nem o cron: o CV cai com alguma frequência.
        console.warn('[Correspondentes] sync falhou:', err.message);
    }
}

export default {
    start() {
        cron.schedule(CRON_EXPR, () => rodar('agendado'), { timezone: TZ });

        // Primeira carga logo após o boot, para a tela não abrir vazia quando
        // as tabelas acabaram de ser criadas.
        setTimeout(() => rodar('boot'), 45_000).unref?.();

        console.log(`✅ Correspondentes agendado — ${CRON_EXPR} (${TZ})`);
    },
};
