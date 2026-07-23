// services/emeReports/ReportChatService.js
//
// Chat streaming (SSE) do builder de relatórios da Eme.
// Agente multi-passo: busca dados via tools comerciais (reuso das tools do
// Office chat) e monta/edita o spec de blocos via report_apply_ops.
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
import { buildReportSystemPrompt } from './reportPrompt.js';
import { normalizeSpec } from './ReportService.js';

// Tools de DADOS liberadas no modo relatório (subset das tools do Office chat).
const DATA_TOOL_NAMES = [
  'query_leads', 'query_enterprises', 'get_enterprise_detail',
  'query_precadastros', 'query_reservas', 'query_mcmv',
  'query_condition_sheets', 'get_condition_sheet',
];
const DATA_TOOL_LABELS = {
  query_leads: 'Leads de marketing',
  query_enterprises: 'Empreendimentos',
  get_enterprise_detail: 'Detalhe do empreendimento',
  query_precadastros: 'Pré-cadastros',
  query_reservas: 'Reservas',
  query_mcmv: 'Teto MCMV',
  query_condition_sheets: 'Fichas comerciais',
  get_condition_sheet: 'Ficha comercial',
};

// Tool de montagem/edição do relatório.
const REPORT_APPLY_DECLARATION = {
  name: 'report_apply_ops',
  description: 'Aplica alterações no relatório em construção: metadados e operações sobre os blocos. Use replace_all na primeira montagem e ops pontuais (upsert/remove/move) nos ajustes.',
  parameters: {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING', description: 'Novo título do relatório (opcional)' },
      enterprise_name: { type: 'STRING', description: 'Empreendimento principal (opcional)' },
      period_start: { type: 'STRING', description: 'Início do período AAAA-MM-DD (opcional)' },
      period_end: { type: 'STRING', description: 'Fim do período AAAA-MM-DD; omita para período aberto (opcional)' },
      data_mode: { type: 'STRING', description: 'fixed (dados congelados) ou live (fim aberto) (opcional)' },
      ops: {
        type: 'ARRAY',
        description: 'Operações sobre os blocos, aplicadas em ordem.',
        items: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', description: 'replace_all | upsert | remove | move' },
            blocks: { type: 'ARRAY', description: 'replace_all: lista completa de blocos {id,type,props}', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, type: { type: 'STRING' }, props: { type: 'OBJECT', properties: {} } } } },
            block: { type: 'OBJECT', description: 'upsert: o bloco {id,type,props} a criar/atualizar', properties: { id: { type: 'STRING' }, type: { type: 'STRING' }, props: { type: 'OBJECT', properties: {} } } },
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

// Extrai a lista de registros de um resultado de tool (formatos variam).
function extractRows(result) {
  if (!result || typeof result !== 'object') return [];
  for (const key of ['rows', 'data', 'items', 'list', 'leads', 'reservas', 'precadastros', 'results']) {
    if (Array.isArray(result[key])) return result[key];
  }
  const firstArray = Object.values(result).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
  return firstArray || [];
}

function bucketDate(value, granularity) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  if (granularity === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (granularity === 'week') {
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

export function analyzeRows(rows, { group_by, metric = 'count', metric_field, date_granularity, top = 10 }) {
  if (!rows.length) return { error: 'Nenhum registro disponível dessa consulta para analisar.' };
  const sample = rows[0];
  if (!(group_by in sample)) {
    return {
      error: `Campo "${group_by}" não existe nos registros.`,
      availableFields: Object.keys(sample).slice(0, 40),
    };
  }

  const groups = new Map();
  for (const row of rows) {
    let key = row[group_by];
    if (key === null || key === undefined || key === '') key = '(não informado)';
    else if (date_granularity) key = bucketDate(key, date_granularity);
    else key = String(key);

    const g = groups.get(key) || { count: 0, sum: 0 };
    g.count += 1;
    if (metric_field != null) {
      const n = Number(row[metric_field]);
      if (Number.isFinite(n)) g.sum += n;
    }
    groups.set(key, g);
  }

  let items = [...groups.entries()].map(([label, g]) => ({
    label,
    value: metric === 'sum' ? g.sum : metric === 'avg' ? (g.count ? g.sum / g.count : 0) : g.count,
    count: g.count,
  }));

  // Série temporal mantém ordem cronológica; o resto ordena por valor
  if (date_granularity) items.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  else items.sort((a, b) => b.value - a.value);

  const total = items.reduce((s, i) => s + i.value, 0);
  const limited = date_granularity ? items : items.slice(0, top);

  return {
    groupBy: group_by,
    metric,
    total: Math.round(total * 100) / 100,
    groupCount: items.length,
    items: limited.map((i) => ({
      ...i,
      value: Math.round(i.value * 100) / 100,
      share: total ? Math.round((i.value / total) * 1000) / 10 : 0,
    })),
    // Leitura pronta para a Eme usar no texto de análise
    topLabel: limited[0]?.label ?? null,
    topShare: total && limited[0] ? Math.round((limited[0].value / total) * 1000) / 10 : null,
  };
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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
  return { spec: normalizeSpec({ version: 1, blocks }), changedIds: [...new Set(changedIds)] };
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

export async function streamReportChat({ req, res, user, report, userMessage, selectedBlockIds = [] }) {
  // Histórico da thread do relatório
  const prior = await db.EmeGeneratedReportMessage.findAll({
    where: { reportId: report.id },
    order: [['created_at', 'ASC']],
    limit: HISTORY_LIMIT,
  });
  const history = prior.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '(operação no relatório)' }],
  }));

  await db.EmeGeneratedReportMessage.create({ reportId: report.id, role: 'user', content: userMessage });

  const selectedBlocks = selectedBlockIds.length
    ? (report.spec?.blocks || []).filter((b) => selectedBlockIds.includes(b.id))
    : [];

  const systemPrompt = buildReportSystemPrompt({ user, report, selectedBlocks });

  const dataDeclarations = OFFICE_TOOL_DECLARATIONS.filter((d) => DATA_TOOL_NAMES.includes(d.name));
  const declarations = [...dataDeclarations, REPORT_ANALYZE_DECLARATION, REPORT_APPLY_DECLARATION];

  // Cliente com retry modelo×chave (mesma estratégia do Office chat, compacta)
  const keys = getKeys();
  if (!keys.length) {
    sendSSE(res, { type: 'error', message: 'GEMINI_API_KEY(S) não configurada(s).' });
    sendSSE(res, { type: 'done' });
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
        firstStream = await chat.sendMessageStream(userMessage);
        break outer;
      } catch (err) {
        const status = err?.status || err?.response?.status;
        if (RETRYABLE.has(status)) continue;
        throw err;
      }
    }
  }
  if (!chat || !firstStream) {
    sendSSE(res, { type: 'error', message: 'IA indisponível no momento. Tente novamente.' });
    sendSSE(res, { type: 'done' });
    return;
  }

  let fullText = '';
  const toolCalls = [];
  let stream = firstStream;

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const pendingCalls = [];
      for await (const chunk of stream.stream) {
        for (const part of chunk.candidates?.[0]?.content?.parts || []) {
          if (part.text) {
            fullText += part.text;
            sendSSE(res, { type: 'chunk', text: part.text });
          }
          if (part.functionCall) pendingCalls.push(part.functionCall);
        }
      }
      if (!pendingCalls.length) break;

      // Executa as tools do round e devolve todas as respostas de uma vez
      const responses = [];
      for (const { name, args } of pendingCalls) {
        const label = DATA_TOOL_LABELS[name]
          || (name === 'report_apply_ops' ? 'Montando o relatório'
            : name === 'report_analyze_data' ? `Analisando ${args?.group_by || 'os dados'}`
              : name);
        sendSSE(res, { type: 'tool_start', name, label });
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
            sendSSE(res, {
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
            result = await officeExecuteTool(name, args || {}, user);
            // Guarda os registros brutos para o report_analyze_data cruzar depois
            putRaw(report.id, name, extractRows(result));
            // Snapshot dos dados usados (auditoria + botão "Atualizar dados")
            const snapshot = report.dataSnapshot || { calls: [] };
            snapshot.calls = [
              ...(snapshot.calls || []).slice(-30),
              { tool: name, label, args: args || {}, at: new Date().toISOString() },
            ];
            await report.update({ dataSnapshot: snapshot, refreshedAt: new Date() });
          } else {
            result = { error: `Ferramenta não permitida no modo relatório: ${name}` };
          }
        } catch (err) {
          console.warn('[ReportChatService] tool error:', name, err?.message);
          result = { error: err?.message || 'Falha na ferramenta.' };
        }
        const ok = !result?.error;
        sendSSE(res, {
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
    sendSSE(res, { type: 'error', message: 'Ocorreu um erro ao processar. Tente novamente.' });
  }

  const saved = await db.EmeGeneratedReportMessage.create({
    reportId: report.id,
    role: 'model',
    content: fullText,
    toolCalls: toolCalls.length ? toolCalls : null,
  });
  sendSSE(res, { type: 'done', msgId: saved.id });
}
