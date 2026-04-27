import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { TOOL_DECLARATIONS, executeTool } from './MarketingTools.js';

dotenv.config();

const STORAGE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB

// Seleciona o cliente Gemini com fallback de chaves
function getGeminiClient() {
  const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  const key = keys[Math.floor(Math.random() * keys.length)];
  return new GoogleGenerativeAI(key);
}

function getModel() {
  const models = (process.env.GEMINI_MODELS || 'gemini-2.0-flash').split(',').map(m => m.trim()).filter(Boolean);
  return models[0];
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

  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
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
  const [memories, enterprises] = await Promise.all([
    db.UserAIMemory.findAll({ where: { user_id: userId } }),
    loadAccessibleEnterprises(fullUser),
  ]);

  const session = await getOrCreateSession(userId, sessionId);
  await saveMessage(session.id, 'user', userMessage);

  const systemPrompt = buildSystemPrompt(fullUser, memories, enterprises);
  const history = await buildHistory(session.id);
  // Remove a última mensagem do histórico (acabamos de salvar, não deve estar no "passado")
  const historyWithoutLast = history.slice(0, -1);

  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({
    model: getModel(),
    systemInstruction: systemPrompt,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
  });

  const chat = model.startChat({ history: historyWithoutLast });

  let fullAssistantText = '';
  let actionResult = null;
  let geminiModel = getModel();

  try {
    const streamResult = await chat.sendMessageStream(userMessage);

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

          // Envia o resultado de volta para o Gemini continuar o texto
          const followUp = await chat.sendMessageStream([
            { functionResponse: { name, response: toolResult } },
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

async function loadAccessibleEnterprises(user) {
  const { QueryTypes } = await import('sequelize');
  const isAdmin = user.role === 'admin';
  const sql = isAdmin
    ? `SELECT DISTINCT enterprise_name FROM enterprise_cities WHERE source = 'crm' AND enterprise_name IS NOT NULL ORDER BY enterprise_name`
    : `SELECT DISTINCT enterprise_name FROM enterprise_cities WHERE source = 'crm' AND enterprise_name IS NOT NULL AND COALESCE(city_override, default_city) = :city ORDER BY enterprise_name`;
  const rows = await db.sequelize.query(sql, {
    replacements: isAdmin ? {} : { city: user.city },
    type: QueryTypes.SELECT,
  });
  return rows.map(r => r.enterprise_name);
}
