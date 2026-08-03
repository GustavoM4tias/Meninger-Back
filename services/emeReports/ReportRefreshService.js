// services/emeReports/ReportRefreshService.js
//
// Refresh do modo AO VIVO. Até aqui `dataMode: 'live'` era só um rótulo: o
// campo era gravado, mas nada re-executava as consultas — os números ficavam
// congelados no spec desde a montagem.
//
// COMO FUNCIONA
// O relatório guarda em `dataSnapshot.calls` as consultas que o alimentaram
// (tool + args). O refresh:
//   1. Reexecuta cada consulta pelo MESMO caminho seguro do chat (SecureRunner
//      para tools do registry, executor legado para as antigas), sempre com as
//      alçadas de quem disparou.
//   2. Reprojeta a janela de tempo: em relatório vivo o fim é aberto, então o
//      `data_fim` congelado na chamada original é substituído por hoje. Sem
//      isso o "ao vivo" pararia no dia em que o relatório foi montado.
//   3. Entrega os resultados frescos à Eme, que reescreve os blocos com os
//      números novos mantendo a estrutura e o texto de análise.
//
// O passo 3 é feito pela própria Eme, e não por substituição mecânica, porque
// os números vivem espalhados em texto, legendas e séries — regravar só o que
// é numérico exigiria um mapa de proveniência que o spec não tem.

import db from '../../models/sequelize/index.js';
import { executeTool as officeExecuteTool } from '../OfficeAI/OfficeChatService.js';
import { findTool } from '../OfficeAI/ToolRegistry.js';
import { runTool as runSecureTool } from '../OfficeAI/SecureRunner.js';

const hoje = () => new Date().toISOString().slice(0, 10);

/**
 * Ajusta os argumentos de data de uma chamada para a janela viva.
 * Só mexe no FIM: o início é a âncora escolhida pelo usuário e não se move.
 */
export function reprojectArgs(args = {}, { periodStart = null } = {}) {
  const out = { ...args };
  // Nomes usados pelas tools de consulta do Office.
  const camposFim = ['data_fim', 'date_to', 'dataFim', 'end_date'];
  const camposInicio = ['data_inicio', 'date_from', 'dataInicio', 'start_date'];

  for (const campo of camposFim) {
    if (campo in out) out[campo] = hoje();
  }
  if (periodStart) {
    for (const campo of camposInicio) {
      if (campo in out) out[campo] = String(periodStart).slice(0, 10);
    }
  }
  return out;
}

/**
 * Reexecuta as consultas registradas no relatório.
 * @returns {Promise<{ ok: boolean, calls: Array, erros: Array }>}
 */
export async function rerunSnapshotCalls(report, user) {
  const calls = Array.isArray(report.dataSnapshot?.calls) ? report.dataSnapshot.calls : [];
  if (!calls.length) {
    return {
      ok: false,
      motivo: 'Este relatório não tem consultas registradas — foi montado antes do registro de origem dos dados. Peça à Eme para refazer a busca no chat.',
      calls: [], erros: [],
    };
  }

  // Deduplica por (tool + args reprojetados): a mesma consulta repetida em
  // turnos diferentes não precisa rodar duas vezes.
  const vistos = new Set();
  const planejadas = [];
  for (const c of calls) {
    const args = reprojectArgs(c.args || {}, { periodStart: report.periodStart });
    const chave = `${c.tool}:${JSON.stringify(args)}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    planejadas.push({ tool: c.tool, label: c.label || c.tool, args });
  }

  const resultados = [];
  const erros = [];
  for (const p of planejadas) {
    try {
      const result = findTool(p.tool)
        ? await runSecureTool({ user, toolName: p.tool, args: p.args, context: 'OFFICE' })
        : await officeExecuteTool(p.tool, p.args, user);
      if (result?.error) erros.push({ tool: p.tool, erro: result.error });
      else resultados.push({ ...p, result });
    } catch (err) {
      erros.push({ tool: p.tool, erro: err?.message || String(err) });
    }
  }

  return { ok: resultados.length > 0, calls: resultados, erros };
}

/**
 * Monta a mensagem que vai pro chat da Eme pedindo a reescrita dos números.
 * Explícita de propósito: sem isso o modelo tende a "confirmar" a atualização
 * sem tocar nos blocos.
 */
export function buildRefreshMessage({ calls, erros, periodStart }) {
  const linhas = calls.map((c) => `- ${c.label} (${c.tool}) com ${JSON.stringify(c.args)}`).join('\n');
  const alerta = erros.length
    ? `\n\nATENÇÃO: ${erros.length} consulta(s) falharam (${erros.map((e) => e.tool).join(', ')}). NÃO invente os números dessas partes: mantenha o valor anterior e registre no relatório que aquele recorte não pôde ser atualizado.`
    : '';

  return `ATUALIZAÇÃO DE DADOS (relatório ao vivo).

Reexecute agora estas consultas e reescreva o relatório com os números novos:
${linhas}

Regras desta atualização:
1. Rode as ferramentas de novo. NUNCA reaproveite número de mensagem anterior desta conversa - os dados mudaram.
2. Mantenha a ESTRUTURA: mesmos blocos, mesmos ids, mesma ordem, mesmos títulos. Troque só valores, séries, tabelas e os números citados no texto.
3. Reescreva as frases de análise que citam número para refletirem os valores novos. Se a leitura mudou (uma taxa que subiu, um empreendimento que virou o pior), diga isso.
4. O período começa em ${periodStart || 'a data de início do relatório'} e vai ATÉ HOJE. Não escreva data final em lugar nenhum.${alerta}`;
}

export default { rerunSnapshotCalls, buildRefreshMessage, reprojectArgs };
