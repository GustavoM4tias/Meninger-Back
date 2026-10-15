// scheduler/cvRoboPainelScheduler.js
//
// O robô do painel do CV: mantém viva a sessão que uma pessoa conectou e,
// com ela viva, roda a reaprovação automática de reservas.
//
// Um job só, de propósito: os dois andam juntos (sem sessão não há o que
// reaprovar) e cada execução vira uma linha no histórico de Sincronizações -
// dois jobs de 4 em 4 minutos dobrariam esse ruído.
//
// 4 minutos: o painel do CV chama o mesmo "mantenha viva" enquanto a página
// está aberta; o intervalo é curto o bastante para nenhum tempo de
// inatividade razoável derrubar a sessão. Editável na tela (CV CRM >
// Configurações > Sincronizações automáticas).

import { manterViva } from '../lib/cvPainelSessao.js';
import { rodar as rodarReaprovacao } from '../services/cv/cvReaprovacaoService.js';

const CRON_EXPR = process.env.CV_ROBO_PAINEL_CRON_EXPRESSION || '*/4 * * * *';

export async function run() {
    const sessao = await manterViva();
    if (sessao.sessao !== 'viva') {
        console.log(`[CV robô] sessão ${sessao.sessao}${sessao.motivo ? `: ${sessao.motivo}` : ''}; reaprovação não roda.`);
        return { sessao: sessao.sessao };
    }
    const r = await rodarReaprovacao();
    if (r.pulado) return { sessao: 'viva', reaprovacao: r.pulado };
    console.log(`[CV robô] reaprovação (${r.modo}): ${r.candidatos} na fila, ${r.aprovadas} aprovada(s), `
        + `${r.simuladas} simulada(s), ${r.fora_da_regra} fora da regra, ${r.erros} erro(s).`);
    return {
        sessao: 'viva',
        reaprovacao: r,
        ...(r.erros ? { parcial: true, falhas: [`${r.erros} reserva(s) com erro na reaprovação`] } : {}),
    };
}

export default { run, cronPadrao: CRON_EXPR };
