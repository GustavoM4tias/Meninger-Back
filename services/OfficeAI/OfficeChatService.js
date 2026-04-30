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
 */
async function buildHistory(sessionId) {
  const messages = await db.ChatMessage.findAll({
    where: { session_id: sessionId },
    order: [['created_at', 'ASC']],
    limit: 40, // janela de contexto: últimas 40 mensagens
  });

  return messages.map(m => {
    let text = m.content;
    // Mensagens de assistente com action são salvas como JSON {"text":"...","action":{...}}
    // Gemini só deve ver o texto — nunca os arrays/objetos brutos da action
    if (m.role === 'assistant' && m.response_type !== 'text') {
      try { text = JSON.parse(m.content).text || ''; } catch { /* mantém original */ }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
  });
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

  const systemPrompt = buildSystemPrompt(fullUser, enterprises);
  const history = await buildHistory(session.id);
  // Remove a última mensagem do histórico (acabamos de salvar, não deve estar no "passado")
  const historyWithoutLast = history.slice(0, -1);

  let fullAssistantText = '';
  let actionResult = null;
  const toolCalls = []; // [{ name, args, result_summary, error, ms }]
  const startedAt = Date.now();

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
          fullAssistantText += part.text;
          sendSSE(res, { type: 'chunk', text: part.text });
        }

        if (part.functionCall) {
          // Descarta qualquer texto emitido antes da tool call (pode conter valores
          // do treinamento do modelo, incorretos em relação ao banco de dados)
          if (fullAssistantText) {
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
                if (followPart.text) {
                  fullAssistantText += followPart.text;
                  sendSSE(res, { type: 'chunk', text: followPart.text });
                }
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
    summary.message = `Tabela gerada com ${summary.total} registros.`;
    // Para tabelas pequenas, inclui os dados para o modelo citar valores corretos
    if (summary.total <= 5 && result.rows?.length) {
      summary.rows = result.rows;
    }
  } else if (type === 'chart') {
    summary.total = result.data?.length ?? 0;
    summary.message = `Gráfico gerado com ${summary.total} categorias.`;
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
