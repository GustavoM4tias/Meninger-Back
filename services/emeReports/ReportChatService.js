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

export async function streamReportChat({ req, res, user, report, userMessage, selectedBlockId }) {
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

  const selectedBlock = selectedBlockId
    ? (report.spec?.blocks || []).find((b) => b.id === selectedBlockId) || null
    : null;

  const systemPrompt = buildReportSystemPrompt({ user, report, selectedBlock });

  const dataDeclarations = OFFICE_TOOL_DECLARATIONS.filter((d) => DATA_TOOL_NAMES.includes(d.name));
  const declarations = [...dataDeclarations, REPORT_APPLY_DECLARATION];

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
        const label = DATA_TOOL_LABELS[name] || (name === 'report_apply_ops' ? 'Montando o relatório' : name);
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
          } else if (DATA_TOOL_NAMES.includes(name)) {
            result = await officeExecuteTool(name, args || {}, user);
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
