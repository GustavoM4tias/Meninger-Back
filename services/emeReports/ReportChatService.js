// services/emeReports/ReportChatService.js
//
// Chat streaming (SSE) do builder de relatórios da Eme.
// Agente multi-passo: busca dados via tools comerciais (reuso das tools do
// Office chat) e monta/edita o spec de blocos via report_apply_ops.
//
// A geração roda como uma RUN desacoplada da conexão HTTP: os eventos são
// bufferizados e retransmitidos a qualquer assinante SSE. Fechar a aba ou dar
// F5 NÃO mata a geração — o front detecta a run ativa (GET /:id → activeRun)
// e reassiste pelo GET /:id/chat/stream, recebendo o replay + o vivo.
//
// Eventos SSE:
//  { type:'chunk', text }                       — texto da Eme
//  { type:'tool_start', name, label }           — progresso Fase A (busca de dados)
//  { type:'tool_result', name, ok, summary }    — item concluído/erro
//  { type:'spec', spec, changedIds, meta }      — spec atualizado (re-render preview)
//  { type:'done', msgId } | { type:'error' }

import { GoogleGenerativeAI } from '@google/generative-ai';
import db from '../../models/sequelize/index.js';
import {
  executeTool as officeExecuteTool,
  TOOL_DECLARATIONS as OFFICE_TOOL_DECLARATIONS,
} from '../OfficeAI/OfficeChatService.js';
import { findTool, toGeminiDeclarations } from '../OfficeAI/ToolRegistry.js';
import { runTool as runSecureTool } from '../OfficeAI/SecureRunner.js';
import { buildReportSystemPrompt } from './reportPrompt.js';
import { normalizeSpec } from './ReportService.js';
import { buildMemoryPrompt, remember } from './ReportMemoryService.js';
// Fonte única do modo relatório interativo: allowlist de tools, análise de
// linhas e labels vivem no ReportDataService (o refresh e a rota /data usam o
// mesmo contrato). Tool nova de dados no relatório → DATA_TOOL_NAMES de lá.
import {
  DATA_TOOL_NAMES, DATA_TOOL_LABELS, extractRows, analyzeRows,
} from './ReportDataService.js';

// Tool de montagem/edição do relatório.
const REPORT_APPLY_DECLARATION = {
  name: 'report_apply_ops',
  description: 'Aplica alterações no relatório em construção: metadados e operações sobre os blocos. Chame VÁRIAS vezes durante a montagem — upsert seção a seção conforme os dados chegam, para o usuário ver o preview se formando. replace_all é só para reestruturar um relatório inteiro que já existe.',
  parameters: {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING', description: 'Novo título do relatório (opcional)' },
      enterprise_name: { type: 'STRING', description: 'Empreendimento principal (opcional)' },
      period_start: { type: 'STRING', description: 'Início do período AAAA-MM-DD (opcional)' },
      period_end: { type: 'STRING', description: 'Fim do período AAAA-MM-DD; omita para período aberto (opcional)' },
      data_mode: { type: 'STRING', description: 'fixed (dados congelados) ou live (fim aberto) (opcional)' },
      filters: {
        type: 'ARRAY',
        description: 'RELATÓRIO INTERATIVO: filtros que o leitor poderá usar. Quando enviado, SUBSTITUI a lista atual de filtros.',
        items: {
          type: 'OBJECT',
          properties: {
            key: { type: 'STRING', description: 'Identificador curto minúsculo (ex: "imob", "corretor", "periodo")' },
            label: { type: 'STRING', description: 'Rótulo exibido ao leitor' },
            type: { type: 'STRING', description: 'select | text | date-range' },
            arg: { type: 'STRING', description: 'Argumento da tool que este filtro alimenta (ex: imobiliaria, corretor, nome, documento, situacao, status_repasse). OMITIR para date-range (vira data_inicio/data_fim automaticamente).' },
            options: { type: 'ARRAY', description: 'Opções fixas do select (opcional)', items: { type: 'STRING' } },
            options_from: { type: 'OBJECT', description: 'Opções dinâmicas do select: distinct de um campo de um dataset. Ex: { dataset: "reservas-lista", field: "imobiliaria_nome" }', properties: { dataset: { type: 'STRING' }, field: { type: 'STRING' } } },
            placeholder: { type: 'STRING', description: 'Texto de apoio (opcional)' },
          },
        },
      },
      datasets: {
        type: 'ARRAY',
        description: 'RELATÓRIO INTERATIVO: consultas parametrizadas que alimentam os blocos com bind. Quando enviado, SUBSTITUI a lista atual.',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING', description: 'Identificador minúsculo (ex: "pastas-kpis", "reservas-situacao")' },
            tool: { type: 'STRING', description: 'Tool de dados permitida (ex: query_precadastros, query_reservas, query_leads)' },
            label: { type: 'STRING', description: 'Nome amigável da fonte' },
            base_args: { type: 'OBJECT', description: 'Args FIXOS da consulta (pode incluir group_by/format/limit — o leitor nunca muda esses)', properties: {} },
            accepts: { type: 'ARRAY', description: 'Keys dos filtros que se aplicam a este dataset', items: { type: 'STRING' } },
          },
        },
      },
      ops: {
        type: 'ARRAY',
        description: 'Operações sobre os blocos, aplicadas em ordem.',
        items: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', description: 'replace_all | upsert | remove | move' },
            blocks: { type: 'ARRAY', description: 'replace_all: lista completa de blocos {id,type,props,bind?}', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, type: { type: 'STRING' }, props: { type: 'OBJECT', properties: {} }, bind: { type: 'OBJECT', description: 'Liga o bloco a um dataset (relatório interativo)', properties: {} } } } },
            block: { type: 'OBJECT', description: 'upsert: o bloco {id,type,props,bind?} a criar/atualizar', properties: { id: { type: 'STRING' }, type: { type: 'STRING' }, props: { type: 'OBJECT', properties: {} }, bind: { type: 'OBJECT', description: 'Liga o bloco a um dataset (relatório interativo)', properties: {} } } },
            id: { type: 'STRING', description: 'remove/move: id do bloco alvo' },
            after_id: { type: 'STRING', description: 'upsert/move: inserir depois deste bloco; omita para o fim' },
          },
        },
      },
    },
  },
};

// Tool de ANÁLISE: agrupa/soma/ordena os registros já trazidos por uma tool de
// dados, sem nova ida ao banco. É o que permite responder "de onde vêm os
// leads", "qual etapa perde mais", "que origem cresceu" sem reconsultar.
const REPORT_ANALYZE_DECLARATION = {
  name: 'report_analyze_data',
  description: 'Analisa os registros retornados por uma consulta anterior desta conversa: agrupa por um campo, aplica uma métrica e ordena. Use para achar padrões (origem, período, etapa, responsável) antes de montar um bloco. Não vai ao banco - trabalha sobre o resultado já buscado.',
  parameters: {
    type: 'OBJECT',
    properties: {
      source_tool: { type: 'STRING', description: 'Nome da tool cujo resultado deve ser analisado (ex.: query_leads)' },
      group_by: { type: 'STRING', description: 'Campo pelo qual agrupar (ex.: origem, situacao, empreendimento, created_at)' },
      metric: { type: 'STRING', description: 'count (padrão) | sum | avg' },
      metric_field: { type: 'STRING', description: 'Campo numérico para sum/avg' },
      date_granularity: { type: 'STRING', description: 'Quando group_by for data: day | week | month' },
      top: { type: 'NUMBER', description: 'Quantos grupos retornar (padrão 10)' },
    },
    required: ['source_tool', 'group_by'],
  },
};

// Tool de MEMÓRIA: a Eme guarda preferências declaradas pelo usuário para não
// precisar ouvir a mesma instrução em toda conversa.
const REPORT_REMEMBER_DECLARATION = {
  name: 'report_remember',
  description: 'Guarda uma preferência GERAL do usuário sobre como fazer relatórios (estrutura, tom, recortes que sempre entram ou nunca entram, regras de negócio). Vale para todos os relatórios dele. Chame quando o usuário declarar um padrão que deve valer nas próximas vezes - não para pedidos pontuais.',
  parameters: {
    type: 'OBJECT',
    properties: {
      text: { type: 'STRING', description: 'A preferência em uma frase clara e acionável, na 3a pessoa. Ex.: "Sempre separar leads de Painel dos leads de mídia paga nas análises de conversão."' },
    },
    required: ['text'],
  },
};

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Runs ativas (geração desacoplada da conexão) ─────────────────────────────
// Uma run por relatório. O buffer guarda TODOS os eventos emitidos, para uma
// reinscrição (F5 no meio da geração) receber o replay completo e continuar
// ao vivo. A run termina sozinha (done/erro/watchdog) e some do mapa pouco
// depois — aí o estado do relatório já está todo no banco.
const RUN_BUFFER_MAX = 5000;
const RUN_DONE_TTL_MS = 60 * 1000;
const RUN_WATCHDOG_MS = 12 * 60 * 1000;
const _activeRuns = new Map(); // reportId -> run

export function getActiveRun(reportId) {
  const run = _activeRuns.get(Number(reportId));
  return run && !run.done ? run : null;
}

function createRun(reportId, userId) {
  const run = {
    reportId: Number(reportId),
    userId,
    startedAt: Date.now(),
    buffer: [],
    subscribers: new Set(),
    done: false,
    watchdog: null,
  };
  _activeRuns.set(run.reportId, run);
  // Se o Gemini travar, a run não pode ficar bloqueando o relatório para sempre
  run.watchdog = setTimeout(() => {
    if (!run.done) {
      emitRun(run, { type: 'error', message: 'A geração demorou demais e foi encerrada. Tente novamente.' });
      emitRun(run, { type: 'done' });
      finishRun(run);
    }
  }, RUN_WATCHDOG_MS);
  run.watchdog.unref?.();
  return run;
}

function emitRun(run, evt) {
  if (run.done) return;
  if (run.buffer.length < RUN_BUFFER_MAX) run.buffer.push(evt);
  for (const res of run.subscribers) {
    try {
      if (!res.writableEnded) sendSSE(res, evt);
    } catch { /* assinante caiu; a run segue */ }
  }
}

function finishRun(run) {
  if (run.done) return;
  run.done = true;
  clearTimeout(run.watchdog);
  for (const res of run.subscribers) {
    try {
      if (!res.writableEnded) res.end();
    } catch { /* já fechada */ }
  }
  run.subscribers.clear();
  setTimeout(() => {
    if (_activeRuns.get(run.reportId) === run) _activeRuns.delete(run.reportId);
  }, RUN_DONE_TTL_MS).unref?.();
}

// Inscreve uma conexão SSE numa run: replay do que já aconteceu + eventos ao
// vivo. Retorna o unsubscribe (ligar no req.on('close')).
export function subscribeToRun(run, res) {
  for (const evt of run.buffer) {
    try { sendSSE(res, evt); } catch { return () => {}; }
  }
  if (run.done) {
    try { res.end(); } catch { /* já fechada */ }
    return () => {};
  }
  run.subscribers.add(res);
  return () => run.subscribers.delete(res);
}

// Dispara a geração em background e devolve a run na hora. Erros inesperados
// viram evento de erro para quem estiver assistindo — nunca uma exceção solta.
export function startReportRun({ user, report, userMessage, selectedBlockIds = [] }) {
  const run = createRun(report.id, user.id);
  (async () => {
    try {
      await runReportGeneration(run, { user, report, userMessage, selectedBlockIds });
    } catch (err) {
      console.error('[ReportChatService] run:', err?.message || err);
      emitRun(run, { type: 'error', message: 'Erro inesperado ao processar. Tente novamente.' });
      emitRun(run, { type: 'done' });
    } finally {
      finishRun(run);
    }
  })();
  return run;
}

// ── Gemini (mesmo esquema de chaves/modelos do Office chat) ──────────────────
function getKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map((k) => k.trim()).filter(Boolean);
}
function getModels() {
  const smart = (process.env.GEMINI_SMART_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
  if (smart.length) return smart;
  return ['gemini-2.5-pro', 'gemini-2.5-flash'];
}

// Aplica as ops do report_apply_ops sobre o spec atual. Retorna { spec, changedIds }.
export function applyOps(currentSpec, payload) {
  let blocks = [...(currentSpec?.blocks || [])];
  const changedIds = [];
  for (const op of payload?.ops || []) {
    if (op.action === 'replace_all' && Array.isArray(op.blocks)) {
      blocks = op.blocks;
      changedIds.push(...op.blocks.map((b) => b?.id).filter(Boolean));
    } else if (op.action === 'upsert' && op.block?.id) {
      const idx = blocks.findIndex((b) => b.id === op.block.id);
      if (idx >= 0) {
        blocks[idx] = op.block;
      } else if (op.after_id) {
        const at = blocks.findIndex((b) => b.id === op.after_id);
        blocks.splice(at >= 0 ? at + 1 : blocks.length, 0, op.block);
      } else {
        blocks.push(op.block);
      }
      changedIds.push(op.block.id);
    } else if (op.action === 'remove' && op.id) {
      blocks = blocks.filter((b) => b.id !== op.id);
    } else if (op.action === 'move' && op.id) {
      const idx = blocks.findIndex((b) => b.id === op.id);
      if (idx >= 0) {
        const [blk] = blocks.splice(idx, 1);
        const at = op.after_id ? blocks.findIndex((b) => b.id === op.after_id) : -1;
        blocks.splice(at >= 0 ? at + 1 : blocks.length, 0, blk);
        changedIds.push(op.id);
      }
    }
  }
  // Filtros/datasets: enviados = substituem; omitidos = preservados.
  const filters = payload?.filters !== undefined ? payload.filters : currentSpec?.filters;
  const datasets = payload?.datasets !== undefined ? payload.datasets : currentSpec?.datasets;
  return {
    spec: normalizeSpec({ version: 1, filters, datasets, blocks }),
    changedIds: [...new Set(changedIds)],
  };
}

// Remove arrays volumosos do resultado antes de devolver ao Gemini (custo de tokens).
function summarizeForGemini(result) {
  if (!result || typeof result !== 'object') return { ok: true };
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) out[k] = v.length > 120 ? v.slice(0, 120) : v;
    else out[k] = v;
  }
  return out;
}

const MAX_TOOL_ROUNDS = 15;
const HISTORY_LIMIT = 30;

// ── Teto de contexto da conversa ─────────────────────────────────────────────
// Só limitar por NÚMERO de mensagens não basta: as do relatório são longas
// (pedidos com tabelas inteiras coladas), e uma thread comprida empurra o
// modelo a responder "de memória" em vez de reconsultar — foi assim que uma
// tabela por empreendimento saiu com números reconstruídos. Aqui o histórico é
// cortado por ORÇAMENTO DE CARACTERES, mantendo sempre as trocas mais recentes,
// e o modelo é avisado de que o começo foi omitido para não achar que aquilo
// nunca existiu.
const HISTORY_CHAR_BUDGET = 24000;
const HISTORY_MSG_MAX_CHARS = 4000;

function trimHistory(messages) {
  const recorte = messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    text: String(m.content || '(operação no relatório)').slice(0, HISTORY_MSG_MAX_CHARS),
  }));

  const mantidas = [];
  let orcamento = HISTORY_CHAR_BUDGET;
  for (let i = recorte.length - 1; i >= 0; i--) {
    const custo = recorte[i].text.length;
    if (mantidas.length && custo > orcamento) break;
    mantidas.unshift(recorte[i]);
    orcamento -= custo;
  }

  const omitidas = recorte.length - mantidas.length;
  const history = mantidas.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  if (omitidas > 0) {
    history.unshift({
      role: 'user',
      parts: [{
        text: `[${omitidas} mensagem(ns) anterior(es) desta conversa foram omitidas por tamanho. `
          + 'O relatório atual, que você recebe no system prompt, é a fonte da verdade sobre o que já foi montado. '
          + 'Se precisar de qualquer NÚMERO que estava nessas mensagens, RECONSULTE com a ferramenta — nunca reconstrua de memória.]',
      }],
    });
  }
  return { history, omitidas };
}

// Cache dos REGISTROS BRUTOS por relatório, para report_analyze_data cruzar os
// dados sem reconsultar o banco. Em memória, com TTL — se expirar, a Eme
// simplesmente busca de novo.
const RAW_TTL_MS = 30 * 60 * 1000;
const _rawCache = new Map(); // reportId -> { at, byTool: { [toolName]: rows } }

function putRaw(reportId, toolName, rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const entry = _rawCache.get(reportId) || { at: Date.now(), byTool: {} };
  entry.at = Date.now();
  entry.byTool[toolName] = rows.slice(0, 5000); // teto de memória
  _rawCache.set(reportId, entry);
}
function getRaw(reportId, toolName) {
  const entry = _rawCache.get(reportId);
  if (!entry || Date.now() - entry.at > RAW_TTL_MS) return null;
  return entry.byTool[toolName] || null;
}
function listRawTools(reportId) {
  const entry = _rawCache.get(reportId);
  if (!entry || Date.now() - entry.at > RAW_TTL_MS) return [];
  return Object.keys(entry.byTool);
}
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _rawCache) {
    if (now - entry.at > RAW_TTL_MS) _rawCache.delete(id);
  }
}, 10 * 60 * 1000).unref?.();

async function runReportGeneration(run, { user, report, userMessage, selectedBlockIds = [] }) {
  // Histórico da thread do relatório
  const prior = await db.EmeGeneratedReportMessage.findAll({
    where: { reportId: report.id },
    order: [['created_at', 'ASC']],
    limit: HISTORY_LIMIT,
  });
  const { history, omitidas } = trimHistory(prior);
  if (omitidas > 0) {
    console.log(`[ReportChatService] histórico do relatório ${report.id}: ${omitidas} mensagem(ns) antiga(s) omitida(s) por orçamento de contexto.`);
  }

  await db.EmeGeneratedReportMessage.create({ reportId: report.id, role: 'user', content: userMessage });

  const selectedBlocks = selectedBlockIds.length
    ? (report.spec?.blocks || []).filter((b) => selectedBlockIds.includes(b.id))
    : [];

  const memoryPrompt = await buildMemoryPrompt(user.id).catch(() => '');
  const systemPrompt = buildReportSystemPrompt({ user, report, selectedBlocks }) + memoryPrompt;

  // Declarações das tools de dados. Duas fontes, porque o Office tem dois
  // registros: o mapa LEGADO (Marketing/Comercial/Alert/Condition) e o
  // ToolRegistry (tools novas, ex.: query_boletos). Antes só o legado entrava
  // aqui, então nenhuma tool do registry era declarada nem executada no modo
  // relatório — e se o usuário pedisse uma pelo nome, o modelo chamava mesmo
  // sem declaração e recebia "Ferramenta desconhecida".
  const registryTools = DATA_TOOL_NAMES.map((n) => findTool(n)).filter(Boolean);
  const legacyDeclarations = OFFICE_TOOL_DECLARATIONS.filter((d) => DATA_TOOL_NAMES.includes(d.name));
  const dataDeclarations = [
    ...legacyDeclarations,
    ...toGeminiDeclarations(registryTools).filter(
      (d) => !legacyDeclarations.some((l) => l.name === d.name),
    ),
  ];
  const declarations = [
    ...dataDeclarations,
    REPORT_ANALYZE_DECLARATION,
    REPORT_REMEMBER_DECLARATION,
    REPORT_APPLY_DECLARATION,
  ];

  // Quando há blocos selecionados, o alvo vai junto da MENSAGEM (não só no
  // system prompt): é o que faz o modelo de fato editar só o que foi marcado.
  const effectiveMessage = selectedBlocks.length
    ? `[O usuário selecionou ${selectedBlocks.length} bloco(s) no relatório: ${selectedBlocks.map((b) => `"${b.id}" (${b.type})`).join(', ')}. Altere APENAS esses blocos, com upsert mantendo os mesmos ids. Não use replace_all.]\n\n${userMessage}`
    : userMessage;

  // Cliente com retry modelo×chave (mesma estratégia do Office chat, compacta)
  const keys = getKeys();
  if (!keys.length) {
    emitRun(run, { type: 'error', message: 'GEMINI_API_KEY(S) não configurada(s).' });
    emitRun(run, { type: 'done' });
    return;
  }
  const models = getModels();
  const RETRYABLE = new Set([401, 403, 429, 500, 503]);

  let chat = null;
  let firstStream = null;
  outer: for (const model of models) {
    for (let k = 0; k < keys.length; k++) {
      try {
        const genAI = new GoogleGenerativeAI(keys[k]);
        const mdl = genAI.getGenerativeModel({
          model,
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: declarations }],
        });
        chat = mdl.startChat({ history });
        firstStream = await chat.sendMessageStream(effectiveMessage);
        break outer;
      } catch (err) {
        const status = err?.status || err?.response?.status;
        if (RETRYABLE.has(status)) continue;
        throw err;
      }
    }
  }
  if (!chat || !firstStream) {
    emitRun(run, { type: 'error', message: 'IA indisponível no momento. Tente novamente.' });
    emitRun(run, { type: 'done' });
    return;
  }

  let fullText = '';
  const toolCalls = [];
  let stream = firstStream;
  let lastFinishReason = null;
  let malformedRetries = 0;
  let emptyBuildNudged = false;

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const pendingCalls = [];
      lastFinishReason = null;
      for await (const chunk of stream.stream) {
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) lastFinishReason = candidate.finishReason;
        for (const part of candidate?.content?.parts || []) {
          if (part.text) {
            fullText += part.text;
            emitRun(run, { type: 'chunk', text: part.text });
          }
          if (part.functionCall) pendingCalls.push(part.functionCall);
        }
      }
      if (!pendingCalls.length) {
        // MALFORMED_FUNCTION_CALL: a API DESCARTA a chamada (tipicamente um
        // report_apply_ops grande demais) e o round termina "limpo". Sem este
        // resgate o modelo acha que montou, o relatório fica vazio e o texto
        // final mente para o usuário — foi exatamente o bug do relatório da
        // Moradas. Devolve o erro ao modelo e manda refazer em partes menores.
        if (String(lastFinishReason).toUpperCase() === 'MALFORMED_FUNCTION_CALL'
          && malformedRetries < 2 && round < MAX_TOOL_ROUNDS) {
          malformedRetries += 1;
          emitRun(run, { type: 'tool_start', name: 'report_apply_ops', label: 'Remontando (chamada malformada)' });
          emitRun(run, { type: 'tool_result', name: 'report_apply_ops', ok: false, summary: 'Chamada descartada pela API; refazendo em partes menores.' });
          stream = await chat.sendMessageStream(
            'ERRO TÉCNICO: sua última chamada de ferramenta foi DESCARTADA pela API por vir malformada '
            + '(provavelmente grande demais). NADA foi aplicado ao relatório. Refaça agora a operação em '
            + 'chamadas report_apply_ops MENORES - uma seção com 2 a 4 blocos por chamada - até completar '
            + 'o que você pretendia. Não escreva a resposta final antes de aplicar tudo.',
          );
          continue;
        }
        // Anti-alucinação: consultou dados, vai encerrar sem ter chamado
        // report_apply_ops nenhuma vez e o relatório está vazio. Uma cutucada
        // única obriga a montagem de verdade em vez de só narrar no chat.
        const aplicou = toolCalls.some((t) => t.name === 'report_apply_ops' && t.ok);
        const buscouDados = toolCalls.some((t) => DATA_TOOL_NAMES.includes(t.name));
        const temBlocos = (report.spec?.blocks || []).length > 0;
        if (!aplicou && buscouDados && !temBlocos && !emptyBuildNudged && round < MAX_TOOL_ROUNDS) {
          emptyBuildNudged = true;
          stream = await chat.sendMessageStream(
            'ERRO TÉCNICO: o relatório continua VAZIO - você não chamou report_apply_ops nenhuma vez '
            + 'nesta resposta. Texto no chat NÃO monta o relatório. Chame report_apply_ops AGORA, seção '
            + 'a seção (hero + metadados primeiro, depois cada seção com os dados já consultados), e só '
            + 'então escreva a resposta final curta.',
          );
          continue;
        }
        break;
      }

      // Executa as tools do round e devolve todas as respostas de uma vez
      const responses = [];
      for (const { name, args } of pendingCalls) {
        const label = DATA_TOOL_LABELS[name]
          || (name === 'report_apply_ops' ? 'Montando o relatório'
            : name === 'report_analyze_data' ? `Analisando ${args?.group_by || 'os dados'}`
              : name === 'report_remember' ? 'Guardando preferência'
                : name);
        emitRun(run, { type: 'tool_start', name, label });
        const t0 = Date.now();
        let result;
        try {
          if (name === 'report_apply_ops') {
            const { spec, changedIds } = applyOps(report.spec, args || {});
            const metaPatch = {};
            if (args?.title) metaPatch.title = String(args.title).slice(0, 200);
            if (args?.enterprise_name) metaPatch.enterpriseName = String(args.enterprise_name).slice(0, 200);
            if (args?.period_start) metaPatch.periodStart = args.period_start;
            if ('period_end' in (args || {})) metaPatch.periodEnd = args.period_end || null;
            if (args?.data_mode && ['fixed', 'live'].includes(args.data_mode)) metaPatch.dataMode = args.data_mode;
            await report.update({ spec, ...metaPatch });
            emitRun(run, {
              type: 'spec',
              spec,
              changedIds,
              meta: {
                title: report.title,
                enterpriseName: report.enterpriseName,
                periodStart: report.periodStart,
                periodEnd: report.periodEnd,
                dataMode: report.dataMode,
              },
            });
            result = { ok: true, blockCount: spec.blocks.length, changedIds };
          } else if (name === 'report_remember') {
            result = await remember({ userId: user.id, text: args?.text, source: 'eme' });
            if (result?.ok) emitRun(run, { type: 'memory_saved', text: args?.text });
          } else if (name === 'report_analyze_data') {
            const sourceTool = args?.source_tool;
            const rows = getRaw(report.id, sourceTool);
            if (!rows) {
              const available = listRawTools(report.id);
              result = {
                error: available.length
                  ? `Nenhum dado em memória de "${sourceTool}". Disponíveis: ${available.join(', ')}. Rode a consulta antes de analisar.`
                  : 'Nenhuma consulta feita ainda nesta conversa. Busque os dados primeiro.',
              };
            } else {
              result = analyzeRows(rows, args || {});
            }
          } else if (DATA_TOOL_NAMES.includes(name)) {
            // Tool do ToolRegistry → SecureRunner (valida alçada/adminOnly e
            // grava auditoria). Tool legada → executor histórico do Office.
            if (findTool(name)) {
              result = await runSecureTool({
                user, toolName: name, args: args || {}, context: 'OFFICE',
              });
            } else {
              result = await officeExecuteTool(name, args || {}, user);
            }
            // Guarda os registros brutos para o report_analyze_data cruzar depois
            putRaw(report.id, name, extractRows(result));
            // Snapshot dos dados usados (auditoria + base do refresh do modo live).
            // O objeto precisa ser NOVO: mutar `report.dataSnapshot` no lugar faz
            // o Sequelize comparar a referência consigo mesma, concluir que nada
            // mudou e PULAR a coluna silenciosamente. Era o que acontecia — só a
            // primeira consulta de cada relatório ficava registrada (quando o
            // campo ainda era null), e todas as seguintes se perdiam.
            const anteriores = Array.isArray(report.dataSnapshot?.calls) ? report.dataSnapshot.calls : [];
            const snapshot = {
              ...(report.dataSnapshot || {}),
              calls: [
                ...anteriores.slice(-30),
                { tool: name, label, args: args || {}, at: new Date().toISOString() },
              ],
            };
            await report.update({ dataSnapshot: snapshot, refreshedAt: new Date() });
          } else {
            result = { error: `Ferramenta não permitida no modo relatório: ${name}` };
          }
        } catch (err) {
          console.warn('[ReportChatService] tool error:', name, err?.message);
          result = { error: err?.message || 'Falha na ferramenta.' };
        }
        const ok = !result?.error;
        emitRun(run, {
          type: 'tool_result', name, label, ok,
          summary: ok
            ? (result?.total != null ? `${result.total} registros` : 'ok')
            : String(result.error).slice(0, 200),
        });
        toolCalls.push({ name, args: args || {}, ok, ms: Date.now() - t0 });
        responses.push({ functionResponse: { name, response: summarizeForGemini(result) } });
      }

      if (round === MAX_TOOL_ROUNDS) break;
      stream = await chat.sendMessageStream(responses);
    }
  } catch (err) {
    console.error('[ReportChatService] Erro no stream:', err?.status || err?.message);
    emitRun(run, { type: 'error', message: 'Ocorreu um erro ao processar. Tente novamente.' });
  }

  const saved = await db.EmeGeneratedReportMessage.create({
    reportId: report.id,
    role: 'model',
    content: fullText,
    toolCalls: toolCalls.length ? toolCalls : null,
  });
  emitRun(run, { type: 'done', msgId: saved.id });
}
