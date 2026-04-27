import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { TOOL_DECLARATIONS as MARKETING_DECLARATIONS, executeTool as marketingExecuteTool } from './MarketingTools.js';
import { TOOL_DECLARATIONS as COMERCIAL_DECLARATIONS, executeTool as comercialExecuteTool } from './ComercialTools.js';

const TOOL_DECLARATIONS = [...MARKETING_DECLARATIONS, ...COMERCIAL_DECLARATIONS];

const _marketingNames = new Set(MARKETING_DECLARATIONS.map(t => t.name));
async function executeTool(name, args, user) {
  return _marketingNames.has(name)
    ? marketingExecuteTool(name, args, user)
    : comercialExecuteTool(name, args, user);
}

dotenv.config();

const STORAGE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB

// Seleciona o cliente Gemini com fallback de chaves
function getGeminiClient() {
  const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  const key = keys[Math.floor(Math.random() * keys.length)];
  return new GoogleGenerativeAI(key);
}

function getModelList() {
  return (process.env.GEMINI_MODELS || 'gemini-2.0-flash').split(',').map(m => m.trim()).filter(Boolean);
}

function getModel() {
  return getModelList()[0];
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

  const systemPrompt = buildSystemPrompt(fullUser, [], enterprises);
  const history = await buildHistory(session.id);
  // Remove a última mensagem do histórico (acabamos de salvar, não deve estar no "passado")
  const historyWithoutLast = history.slice(0, -1);

  let fullAssistantText = '';
  let actionResult = null;
  let geminiModel = getModel();

  // Tenta cada modelo da lista em ordem — fallback automático em caso de 503
  let chat = null;
  let streamResult = null;
  const modelList = getModelList();
  for (let i = 0; i < modelList.length; i++) {
    try {
      const genAI = getGeminiClient();
      const mdl = genAI.getGenerativeModel({
        model: modelList[i],
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      });
      chat = mdl.startChat({ history: historyWithoutLast });
      streamResult = await chat.sendMessageStream(userMessage);
      geminiModel = modelList[i];
      break;
    } catch (err) {
      if (i < modelList.length - 1 && err.status === 503) {
        console.warn(`[OfficeChatService] Modelo ${modelList[i]} indisponível (503), tentando ${modelList[i + 1]}...`);
        continue;
      }
      throw err;
    }
  }

  try {

    for await (const chunk of streamResult.stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      for (const part of candidate.content?.parts || []) {
        if (part.text) {
          fullAssistantText += part.text;
          sendSSE(res, { type: 'chunk', text: part.text });
        }

        if (part.functionCall) {
          const { name, args } = part.functionCall;
          const toolResult = await executeTool(name, args, fullUser);

          if (name === 'save_memory') {
            // Memória salva silenciosamente, não envia para o frontend
          } else {
            actionResult = toolResult;
            sendSSE(res, { type: 'action', action: toolResult });
          }

          // Envia o resultado de volta para o Gemini (sem arrays volumosos — evita JSON no texto)
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
    hasAction: !!actionResult,
  });

  sendSSE(res, { type: 'done', sessionId: session.id, msgId: savedMsg.id });
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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
