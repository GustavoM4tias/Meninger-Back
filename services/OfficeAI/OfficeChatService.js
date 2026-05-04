import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { TOOL_DECLARATIONS as MARKETING_DECLARATIONS, executeTool as marketingExecuteTool } from './MarketingTools.js';
import { TOOL_DECLARATIONS as COMERCIAL_DECLARATIONS, executeTool as comercialExecuteTool } from './ComercialTools.js';

// Registry: nome → { declaration, executor }
const TOOLS = new Map();
function registerTools(declarations, executor) {
  for (const d of declarations) TOOLS.set(d.name, { declaration: d, executor });
}
registerTools(MARKETING_DECLARATIONS, marketingExecuteTool);
registerTools(COMERCIAL_DECLARATIONS, comercialExecuteTool);

const TOOL_DECLARATIONS = [...TOOLS.values()].map(t => t.declaration);

async function executeTool(name, args, user) {
  const tool = TOOLS.get(name);
  if (!tool) return { error: `Ferramenta desconhecida: ${name}` };
  return tool.executor(name, args, user);
}

dotenv.config();

const STORAGE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB

// ── Chaves Gemini com rotação por tentativa ──────────────────────────────────
function getGeminiKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map(k => k.trim()).filter(Boolean);
}

function getGeminiClient(keyIndex = null) {
  const keys = getGeminiKeys();
  if (!keys.length) throw new Error('GEMINI_API_KEY(S) não configurada(s).');
  const idx = keyIndex == null ? Math.floor(Math.random() * keys.length) : keyIndex % keys.length;
  return new GoogleGenerativeAI(keys[idx]);
}

// ── Listas de modelos: fast (padrão) e smart (escalonado para queries complexas) ──
function parseList(env) {
  return (env || '').split(',').map(m => m.trim()).filter(Boolean);
}
function getFastModels() {
  const fast = parseList(process.env.GEMINI_FAST_MODELS);
  if (fast.length) return fast;
  return parseList(process.env.GEMINI_MODELS) || ['gemini-2.5-flash'];
}
function getSmartModels() {
  const smart = parseList(process.env.GEMINI_SMART_MODELS);
  if (smart.length) return smart;
  // Default: pro com fallback para flash se pro indisponível
  return ['gemini-2.5-pro', ...getFastModels()];
}

/**
 * Heurística para escolher entre pool "fast" (flash) e "smart" (pro).
 * Critério conservador: usa smart só quando há sinais claros de complexidade,
 * para preservar coerência sem custo extra na maioria das interações.
 */
function selectModelPool(userMessage) {
  const text = (userMessage || '').toLowerCase();

  // Sinal 1: mensagem longa
  if (text.length > 280) return 'smart';

  // Sinal 2: múltiplas perguntas
  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks >= 2) return 'smart';

  // Sinal 3: intenção de análise/comparação/raciocínio
  const SMART_KEYWORDS = [
    'compar', 'analis', 'analís', 'diferenç', 'estratég', ' versus ', ' vs ',
    'por que ', 'porque ', 'recomend', 'sugir', 'sugest', 'previs', 'tendênc',
    'qual o melhor', 'qual a melhor', 'mais eficient', 'oportunidade',
    'avalia', 'explica em detalh', 'projet', 'cenário',
  ];
  if (SMART_KEYWORDS.some(kw => text.includes(kw))) return 'smart';

  // Sinal 4: múltiplas restrições combinadas
  if (/\b(e também|além disso|ao mesmo tempo)\b/.test(text)) return 'smart';

  // Sinal 5: referências a dados anteriores ("dessas", "esses", "as 14", "do anterior")
  // — perguntas contextuais exigem mais raciocínio para não alucinar baseado em
  //   memória/histórico (flash tende a inventar; pro respeita melhor a regra de
  //   chamar a tool de novo).
  const CONTEXTUAL_REFS = [
    /\bdess[ae]s?\b/, /\bdest[ae]s?\b/, /\bnest[ae]s?\b/, /\bness[ae]s?\b/,
    /\bo total\b/, /\ba lista\b/, /\bos dados\b/,
    /\b(as|os) anteriores?\b/, /\bdo anterior\b/, /\bdescritos?\b/,
    /\bpor (empreendimento|cca|empresa|banco|origem|imobili|corretor|m[eê]s|dia|cidade|bucket|funil|etapa)/,
    /\bdistribuí?d[ao]s?\b/, /\bquant[ao]s? por\b/, /\bquais clientes\b/,
    /\bdivis[aã]o\b/, /\bbreakdown\b/, /\bdivid[ai]?d[ao]s?\b/,
    // Referências indiretas a registros mostrados antes — exigem bridge inteligente
    /\b(?:por|pelo|pela)\s+(?:el[ae]s?|cliente|nome|documento|cpf|reserva|pasta)\b/,
    /\b(?:busque|procure|encontre|abra)\s+(?:pelo|pela|por|o|a|os|as)\s/,
    /\b(?:essa|esse|essas|esses)\s+(?:reserva|pasta|cliente|lead|empreendimento)\b/,
  ];
  if (CONTEXTUAL_REFS.some(re => re.test(text))) return 'smart';

  return 'fast';
}

/**
 * Retorna o uso de armazenamento atual do usuário em bytes.
 */
export async function getUserStorageUsage(userId) {
  const result = await db.ChatSession.findOne({
    attributes: [[db.sequelize.fn('SUM', db.sequelize.col('total_bytes')), 'total']],
    where: { user_id: userId, deleted_at: null },
    raw: true,
  });
  return Number(result?.total || 0);
}

/**
 * Carrega ou cria uma sessão de chat.
 */
export async function getOrCreateSession(userId, sessionId = null) {
  if (sessionId) {
    const session = await db.ChatSession.findOne({
      where: { id: sessionId, user_id: userId, deleted_at: null },
    });
    if (session) return session;
  }
  return db.ChatSession.create({ user_id: userId, title: null });
}

/**
 * Salva uma mensagem na sessão e atualiza o contador de bytes.
 */
export async function saveMessage(sessionId, role, content, responseType = 'text', metadata = {}) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const msg = await db.ChatMessage.create({
    session_id: sessionId,
    role,
    content,
    response_type: responseType,
    metadata,
    bytes_used: bytes,
  });
  await db.ChatSession.increment('total_bytes', { by: bytes, where: { id: sessionId } });

  // Atualiza título com a primeira mensagem do usuário
  if (role === 'user') {
    const session = await db.ChatSession.findByPk(sessionId);
    if (!session.title) {
      const title = content.slice(0, 80);
      await session.update({ title });
    }
  }

  return msg;
}

/**
 * Monta o histórico de mensagens no formato Gemini (contents array).
 * Histórico é mantido LIMPO — apenas .text das mensagens. Os IDs/filtros para
 * bridge entre módulos vão na systemInstruction (via getLastBridgeContext)
 * para o modelo não replicar o bloco em respostas seguintes.
 */
async function buildHistory(sessionId) {
  const messages = await db.ChatMessage.findAll({
    where: { session_id: sessionId },
    order: [['created_at', 'ASC']],
    limit: 40,
  });

  return messages.map(m => {
    let text = m.content;
    if (m.role === 'assistant' && m.response_type !== 'text') {
      try { text = JSON.parse(m.content).text || ''; } catch { /* mantém */ }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
  });
}

/**
 * Busca a última mensagem do assistente que carrega CONTEXTO DE DADOS útil
 * para bridge entre módulos. Pula respostas tipo `navigate`, `error` e quaisquer
 * outras que não tenham IDs/filtros aproveitáveis. Garante que após o usuário
 * pedir "abra o relatório", o contexto da consulta de DADOS anterior continue
 * disponível para a próxima pergunta.
 */
async function getLastBridgeContext(sessionId) {
  const candidates = await db.ChatMessage.findAll({
    where: {
      session_id: sessionId,
      role: 'assistant',
      response_type: {
        [db.Sequelize.Op.notIn]: ['text', 'navigate', 'error'],
      },
    },
    order: [['created_at', 'DESC']],
    limit: 5,
  });

  let action = null;
  for (const msg of candidates) {
    try {
      const parsed = JSON.parse(msg.content);
      const a = parsed.action;
      const ctx = a?.context;
      if (!ctx) continue;
      // Aceita só se tem IDs ou source identificável — descarta contextos vazios
      const hasIds = ['idleads', 'idprecadastros', 'idreservas', 'documentos']
        .some(k => Array.isArray(ctx[k]) && ctx[k].length);
      const hasFilters = ctx.source && (ctx.data_inicio || hasIds);
      if (hasIds || hasFilters) { action = a; break; }
    } catch { /* skip */ }
  }
  if (!action || !action.context) return '';
  const c = action.context;

  const bits = [];
  if (c.source)                 bits.push(`source=${c.source}`);
  if (c.data_inicio || c.data_fim) bits.push(`periodo=${c.data_inicio || '?'}..${c.data_fim || '?'}`);
  if (c.bucket)                 bits.push(`bucket=${c.bucket}`);
  if (c.empreendimento)         bits.push(`empreendimento=${c.empreendimento}`);
  if (c.empresa_correspondente) bits.push(`cca=${c.empresa_correspondente}`);
  if (c.situacao_nome)          bits.push(`situacao=${c.situacao_nome}`);
  if (c.with_lead)              bits.push('with_lead=true');
  if (c.excluir_painel)         bits.push('excluir_painel=true');
  if (c.only_active)            bits.push('only_active=true');
  if (c.format)                 bits.push(`format=${c.format}`);

  const arrayKeys = ['idleads', 'idprecadastros', 'idreservas', 'idrepasses', 'documentos'];
  for (const key of arrayKeys) {
    if (Array.isArray(c[key]) && c[key].length) {
      const slice = c[key].slice(0, 100);
      bits.push(`${key}=${slice.join(',')}${c[key].length > 100 ? `,...(+${c[key].length - 100})` : ''}`);
    }
  }

  if (!bits.length) return '';
  return bits.join(' | ');
}

/**
 * Stream principal — SSE.
 * Envia eventos para `res` conforme o Gemini responde ou chama ferramentas.
 *
 * Eventos SSE emitidos:
 *   {type:"chunk", text:"..."}       — texto parcial
 *   {type:"action", action:{...}}    — navigate / table / chart
 *   {type:"done", sessionId, msgId}  — stream concluído
 *   {type:"error", message:"..."}    — erro
 */
export async function streamChat({ req, res, userId, sessionId, userMessage }) {
  // Verifica limite de armazenamento
  const usage = await getUserStorageUsage(userId);
  if (usage >= STORAGE_LIMIT_BYTES) {
    sendSSE(res, { type: 'error', code: 'STORAGE_LIMIT', message: 'Você atingiu o limite de 20 MB de histórico. Exclua alguns chats para continuar.' });
    sendSSE(res, { type: 'done' });
    return;
  }

  // Carrega dados do usuário (city, position, etc.) + memórias
  const fullUser = await db.User.findByPk(userId, {
    attributes: ['id', 'username', 'email', 'role', 'position', 'city'],
  });
  const [enterprises] = await Promise.all([
    loadAccessibleEnterprises(fullUser),
  ]);

  const session = await getOrCreateSession(userId, sessionId);
  await saveMessage(session.id, 'user', userMessage);

  let systemPrompt = buildSystemPrompt(fullUser, enterprises);
  // Anexa contexto de bridge (IDs/filtros da última consulta) ao SYSTEM
  // instruction — não ao histórico — para evitar que o modelo replique o bloco.
  const lastBridge = await getLastBridgeContext(session.id);
  if (lastBridge) {
    systemPrompt += `\n\n## CONTEXTO TÉCNICO INTERNO (não reproduza em respostas)\n` +
      `IDs e filtros da última consulta — disponíveis para bridge entre módulos:\n` +
      `${lastBridge}\n\n` +
      `**REGRA RÍGIDA:** este bloco é APENAS para você consultar. NUNCA escreva, copie ou cite ` +
      `os IDs ou filtros acima na sua resposta de texto. Use-os apenas como argumento de tool calls.`;
  }
  const history = await buildHistory(session.id);
  // Remove a última mensagem do histórico (acabamos de salvar, não deve estar no "passado")
  const historyWithoutLast = history.slice(0, -1);

  let fullAssistantText = '';
  let actionResult = null;
  const toolCalls = [];
  const startedAt = Date.now();
  const bridgeFilter = makeBridgeFilter();

  // Helper: filtra chunk antes de emitir + acumula só o que sai limpo
  const emitTextChunk = (raw) => {
    const safe = bridgeFilter.push(raw);
    if (safe) {
      fullAssistantText += safe;
      sendSSE(res, { type: 'chunk', text: safe });
    }
  };

  // Seleciona pool com base na complexidade da pergunta (fast por padrão, smart se necessário)
  const pool = selectModelPool(userMessage);
  const modelList = pool === 'smart' ? getSmartModels() : getFastModels();
  let geminiModel = modelList[0];

  // Tenta cada modelo + cada chave em ordem — fallback automático em 503/429/401/500.
  // IMPORTANTE: o erro 503 do Gemini frequentemente surge no PRIMEIRO chunk (durante
  // a iteração do stream), não na chamada `sendMessageStream`. Por isso puxamos o
  // primeiro chunk dentro do loop de retry — só assim conseguimos cair no próximo modelo.
  const keysCount = Math.max(getGeminiKeys().length, 1);
  const RETRYABLE = new Set([401, 403, 429, 500, 503]);
  let chat = null;
  let streamIterator = null;
  let firstChunk = null;
  outer: for (let i = 0; i < modelList.length; i++) {
    for (let k = 0; k < keysCount; k++) {
      try {
        const genAI = getGeminiClient(k);
        const mdl = genAI.getGenerativeModel({
          model: modelList[i],
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        });
        chat = mdl.startChat({ history: historyWithoutLast });
        const streamResult = await chat.sendMessageStream(userMessage);
        streamIterator = streamResult.stream[Symbol.asyncIterator]();
        // Consome o primeiro chunk dentro do retry para capturar 503 que vem assíncrono
        const first = await streamIterator.next();
        firstChunk = first.done ? null : first.value;
        geminiModel = modelList[i];
        break outer;
      } catch (err) {
        const status = err?.status || err?.response?.status;
        const lastModel = i === modelList.length - 1;
        const lastKey = k === keysCount - 1;
        if (RETRYABLE.has(status) && !(lastModel && lastKey)) {
          console.warn(`[OfficeChatService] Falha ${status} em ${modelList[i]} (key #${k}), tentando próximo...`);
          continue;
        }
        throw err;
      }
    }
  }

  // Gera um async iterator que reemite o primeiro chunk + resto do stream
  async function* mergedStream() {
    if (firstChunk) yield firstChunk;
    while (true) {
      const r = await streamIterator.next();
      if (r.done) break;
      yield r.value;
    }
  }

  try {

    for await (const chunk of mergedStream()) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      for (const part of candidate.content?.parts || []) {
        if (part.text) {
          emitTextChunk(part.text);
        }

        if (part.functionCall) {
          // Descarta qualquer texto emitido antes da tool call (pode conter valores
          // do treinamento do modelo, incorretos em relação ao banco de dados)
          if (fullAssistantText || bridgeFilter.flush()) {
            fullAssistantText = '';
            sendSSE(res, { type: 'clear' });
          }

          const { name, args } = part.functionCall;
          const toolStart = Date.now();
          const toolResult = await executeTool(name, args, fullUser);

          toolCalls.push({
            name,
            args: args || {},
            result_summary: summarizeForFeedback(toolResult),
            error: toolResult?.error || null,
            ms: Date.now() - toolStart,
          });

          actionResult = toolResult;
          sendSSE(res, { type: 'action', action: toolResult });

          // Envia o resultado de volta para o Gemini (sem arrays volumosos — evita JSON no texto).
          // Falhas aqui (503, etc.) não devem matar a resposta: o usuário já recebeu a ação/dados.
          try {
            const followUp = await chat.sendMessageStream([
              { functionResponse: { name, response: summarizeForGemini(toolResult) } },
            ]);
            for await (const followChunk of followUp.stream) {
              for (const followPart of followChunk.candidates?.[0]?.content?.parts || []) {
                if (followPart.text) emitTextChunk(followPart.text);
              }
            }
          } catch (followErr) {
            console.warn('[OfficeChatService] Falha no follow-up após tool call:', followErr?.status || followErr?.message);
            // Mantém a actionResult — o frontend já exibe os dados sem texto final.
          }
        }
      }
    }
  } catch (err) {
    console.error('[OfficeChatService] Erro no stream Gemini:', err);
    sendSSE(res, { type: 'error', message: 'Desculpe, ocorreu um erro ao processar sua mensagem.' });
    sendSSE(res, { type: 'done', sessionId: session.id });
    return;
  }

  // Flush final do filtro — emite qualquer texto retido (sem bridges) ao usuário
  const tail = bridgeFilter.flush();
  if (tail) {
    fullAssistantText += tail;
    sendSSE(res, { type: 'chunk', text: tail });
  }

  // Pós-filtro: remove pseudo-tool-calls (ex: "call:query_X{...}" ou "query_X({...})")
  // que o modelo às vezes escreve em texto ao invés de invocar via function calling API.
  // Isso é defensivo — o modelo está proibido pelo prompt, mas pode escapar.
  const cleanedFinal = stripPseudoToolCalls(fullAssistantText);
  if (cleanedFinal !== fullAssistantText) {
    sendSSE(res, { type: 'replace', text: cleanedFinal });
    fullAssistantText = cleanedFinal;
  }

  // Salva resposta final do assistente
  const responseType = actionResult?.type || 'text';
  const contentToSave = actionResult
    ? JSON.stringify({ text: fullAssistantText, action: actionResult })
    : fullAssistantText;

  const savedMsg = await saveMessage(session.id, 'assistant', contentToSave, responseType, {
    model: geminiModel,
    pool,
    hasAction: !!actionResult,
    tool_calls: toolCalls,
    latency_ms: Date.now() - startedAt,
  });

  sendSSE(res, { type: 'done', sessionId: session.id, msgId: savedMsg.id });
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Remove pseudo-tool-call syntax que o modelo às vezes escreve em texto:
 *   - "call:query_xxx{...}" / "call: query_xxx(...)"
 *   - "query_xxx({...})" / "query_xxx(...)" em linha solta
 *   - "tool_code\n...\n"
 * Tool calls reais são feitas via function calling API; texto com essa syntax
 * é vazamento — confunde o usuário e pode conter IDs.
 */
function stripPseudoToolCalls(text) {
  if (!text) return text;
  let out = text;
  // call:func{...} ou call: func(...) — qualquer linha contendo isso
  out = out.replace(/\bcall\s*:\s*\w+\s*[{(][^}\n)]*[)}]/gi, '');
  // query_xxx({ ... }) ou query_xxx(...) ou similar como linha-comando standalone
  out = out.replace(/(^|\n)\s*(query_|navigate_|get_)\w+\s*\(\s*\{[^}]*\}\s*\)\s*(?=\n|$)/g, '$1');
  out = out.replace(/(^|\n)\s*(query_|navigate_|get_)\w+\s*\(\s*[^)\n]*\)\s*(?=\n|$)/g, '$1');
  // "tool_code:" ou "function_call:" prefixos suspeitos
  out = out.replace(/\b(tool_code|function_call|tool_invocation)\s*[:=].*$/gmi, '');
  // Limpa múltiplas linhas em branco consecutivas
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/**
 * Filtro de stream defensivo. Remove do output:
 *   1. Blocos [__bridge__: ...] ou [bridge: ...] (contexto técnico interno)
 *   2. Blocos de código markdown ```...``` (modelo despejando JSON/arrays)
 *   3. Dumps de arrays/objetos que parecem listagem de dados (json/array)
 * Lida corretamente com blocos cruzando fronteiras de chunk.
 */
function makeBridgeFilter() {
  let buf = '';
  // states: 'normal' | 'bridge' | 'fence' (```...```) | 'jsonArr' ([...])
  let state = 'normal';
  const BRIDGE_START = /^\[(?:__bridge__|bridge)\b/i;
  // Detecta abertura de array JSON com objetos: "[" seguido de "{" (com whitespace)
  const JSON_ARR_START = /^\[\s*\{/;

  return {
    push(text) {
      buf += text;
      let out = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (state === 'normal') {
          // Procura próximo gatilho: [, ```, ou nada
          const fenceIdx  = buf.indexOf('```');
          const bracketIdx = buf.indexOf('[');
          const candidates = [fenceIdx, bracketIdx].filter(i => i >= 0);
          if (!candidates.length) { out += buf; buf = ''; break; }
          const idx = Math.min(...candidates);
          out += buf.slice(0, idx);
          buf = buf.slice(idx);

          if (buf.startsWith('```')) { state = 'fence'; continue; }
          // É um '['. Pode ser bridge, json array, ou texto comum.
          // Precisa esperar mais chars para classificar.
          if (buf.length < 12) {
            // Sem context suficiente. Preserva no buffer.
            // Se claramente não é nem bridge nem json-array de objetos, libera.
            const probe = buf.toLowerCase();
            const couldBeBridge =
              '[__bridge__:'.startsWith(probe) || '[bridge:'.startsWith(probe);
            const couldBeJsonArr = /^\[\s*\{?$/.test(buf); // [ ou [{
            if (!couldBeBridge && !couldBeJsonArr) {
              // Libera o '[' isolado e continua processando
              out += buf[0];
              buf = buf.slice(1);
              continue;
            }
            return out;
          }
          // Classifica
          if (BRIDGE_START.test(buf))      { state = 'bridge';  continue; }
          if (JSON_ARR_START.test(buf))    { state = 'jsonArr'; continue; }
          // É um '[' comum em texto — libera
          out += buf[0];
          buf = buf.slice(1);
          continue;
        }
        if (state === 'bridge') {
          const close = buf.indexOf(']');
          if (close < 0) return out;
          buf = buf.slice(close + 1);
          state = 'normal';
          continue;
        }
        if (state === 'fence') {
          // Procura fechamento ``` após o de abertura (3 chars)
          const close = buf.indexOf('```', 3);
          if (close < 0) return out;
          buf = buf.slice(close + 3);
          state = 'normal';
          continue;
        }
        if (state === 'jsonArr') {
          // Procura fechamento ] balanceando [/]
          let depth = 0;
          let inStr = false;
          let escape = false;
          let endIdx = -1;
          for (let i = 0; i < buf.length; i++) {
            const ch = buf[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"')  { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '[') depth++;
            else if (ch === ']') {
              depth--;
              if (depth === 0) { endIdx = i; break; }
            }
          }
          if (endIdx < 0) return out;
          buf = buf.slice(endIdx + 1);
          state = 'normal';
          continue;
        }
      }
      return out;
    },
    flush() {
      const remaining = buf;
      buf = '';
      // Se sobrou bloco aberto suspeito, descarta
      const inSuspect = state !== 'normal';
      state = 'normal';
      if (inSuspect) return '';
      // No estado normal, pode ter resíduo de '[' — libera
      return remaining;
    },
  };
}

/**
 * Resumo do resultado da tool para auditoria/feedback (não vai para o Gemini).
 * Preserva os filtros aplicados, totais e amostra dos dados — útil para
 * reconstruir o raciocínio do assistente no painel de Insights.
 */
function summarizeForFeedback(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error) return { error: result.error };

  const { type, title, total, context } = result;
  const out = { type, title, context: context || null };

  if (type === 'table') {
    out.total = total ?? result.rows?.length ?? 0;
    if (result.columns) out.columns = result.columns.map(c => c.label || c.key);
    if (result.rows?.length) out.sample_rows = result.rows.slice(0, 3);
  } else if (type === 'chart') {
    out.total = result.data?.length ?? 0;
    out.labels = result.labels;
    out.data = result.data;
  } else if (type === 'navigate') {
    out.route = result.route;
    out.filters = result.filters;
    out.message = result.message;
  } else if (type === 'detail') {
    out.focus = result.focus;
    out.id = result.id;
    out.nome = result.nome;
  }
  return out;
}

/**
 * Remove arrays volumosos do resultado da tool antes de enviar ao Gemini.
 * Evita que o modelo reproduza o JSON bruto na resposta de texto.
 */
function summarizeForGemini(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.error) return { error: result.error };

  const { type, title, total, context } = result;
  const summary = { type, title, context };

  if (type === 'table') {
    summary.total = total ?? result.rows?.length ?? 0;
    summary.message =
      `A tabela com ${summary.total} registros já está RENDERIZADA visualmente na UI do chat. ` +
      `Sua resposta de texto deve ter NO MÁXIMO 1 frase curta de introdução/comentário. ` +
      `NÃO liste, escreva, copie, dump, cite ou reproduza os dados (linhas, nomes, CPFs, valores, JSON, listas). ` +
      `NÃO invente dados — se você não tem um valor específico, diga "veja na tabela" e pare.`;
    // Para tabelas pequenas, inclui os dados para o modelo citar valores corretos
    if (summary.total <= 5 && result.rows?.length) {
      summary.rows = result.rows;
    }
  } else if (type === 'chart') {
    summary.total = result.data?.length ?? 0;
    summary.message =
      `O gráfico com ${summary.total} categorias já está RENDERIZADO visualmente na UI. ` +
      `Faça apenas 1-2 frases de comentário (insight, destaque). NÃO liste todos os valores nem reproduza os dados em texto.`;
    // Inclui labels compactos para o modelo poder mencionar
    if (result.labels?.length <= 10) {
      summary.labels = result.labels;
      summary.data   = result.data;
    }
  } else if (type === 'navigate') {
    summary.route   = result.route;
    summary.filters = result.filters;
    summary.message = result.message;
  } else {
    // detail ou outros — passa campos escalares, exclui arrays grandes
    for (const [k, v] of Object.entries(result)) {
      if (!Array.isArray(v)) summary[k] = v;
    }
  }

  return summary;
}

async function loadAccessibleEnterprises(user) {
  const { QueryTypes } = await import('sequelize');
  const isAdmin = user.role === 'admin';
  const sql = isAdmin
    ? `SELECT ce.nome AS enterprise_name, COALESCE(ec.city_override, ec.default_city, ce.cidade) AS cidade
       FROM cv_enterprises ce
       LEFT JOIN enterprise_cities ec ON ec.source = 'crm' AND ec.crm_id = ce.idempreendimento
       WHERE ce.nome IS NOT NULL
       ORDER BY ce.nome`
    : `SELECT ce.nome AS enterprise_name, COALESCE(ec.city_override, ec.default_city, ce.cidade) AS cidade
       FROM cv_enterprises ce
       LEFT JOIN enterprise_cities ec ON ec.source = 'crm' AND ec.crm_id = ce.idempreendimento
       WHERE ce.nome IS NOT NULL
         AND COALESCE(ec.city_override, ec.default_city, ce.cidade) ILIKE :city
       ORDER BY ce.nome`;
  const rows = await db.sequelize.query(sql, {
    replacements: isAdmin ? {} : { city: `%${user.city}%` },
    type: QueryTypes.SELECT,
  });
  return rows.map(r => ({ name: r.enterprise_name, cidade: r.cidade || 'N/A' }));
}
