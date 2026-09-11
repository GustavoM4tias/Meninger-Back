import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import db from '../models/sequelize/index.js';
import {
  streamChat,
  getUserStorageUsage,
  getOrCreateSession,
} from '../services/OfficeAI/OfficeChatService.js';
import { synthesizeSpeech, ALLOWED_VOICES } from '../services/OfficeAI/EmeTTSService.js';
import { validarMemoria, userEmeSettings, MEMORY_CATEGORIES } from '../services/OfficeAI/MemoryTools.js';
import { PERIODO_KEYS } from '../services/OfficeAI/periodo.js';

const router = express.Router();

// ── Rate limit por usuário ────────────────────────────────────────────────────
// Janela curta (anti-spam) + janela longa (anti-abuso). Em memória — suficiente
// para single-server. Para múltiplas instâncias, migrar para Redis.
const RATE_LIMITS = {
  short: { windowMs: 60 * 1000,        max: 15 },   // 15 msgs/min
  long:  { windowMs: 60 * 60 * 1000,   max: 200 },  // 200 msgs/hora
};
const _rateBuckets = new Map(); // userId -> { short: [ts...], long: [ts...] }

function pruneAndCount(arr, windowMs, now) {
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return arr.length;
}

function rateLimitChat(req, res, next) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Não autenticado.' });

  const now = Date.now();
  let bucket = _rateBuckets.get(userId);
  if (!bucket) {
    bucket = { short: [], long: [] };
    _rateBuckets.set(userId, bucket);
  }

  const shortCount = pruneAndCount(bucket.short, RATE_LIMITS.short.windowMs, now);
  const longCount  = pruneAndCount(bucket.long,  RATE_LIMITS.long.windowMs,  now);

  if (shortCount >= RATE_LIMITS.short.max) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Você enviou muitas mensagens em sequência. Aguarde um instante e tente novamente.' });
  }
  if (longCount >= RATE_LIMITS.long.max) {
    res.set('Retry-After', '3600');
    return res.status(429).json({ error: 'Limite horário de mensagens atingido. Tente novamente mais tarde.' });
  }

  bucket.short.push(now);
  bucket.long.push(now);
  next();
}

// Limpeza periódica do mapa para evitar crescimento indefinido
setInterval(() => {
  const now = Date.now();
  const longest = RATE_LIMITS.long.windowMs;
  for (const [uid, bucket] of _rateBuckets) {
    pruneAndCount(bucket.short, RATE_LIMITS.short.windowMs, now);
    pruneAndCount(bucket.long,  longest,                    now);
    if (!bucket.short.length && !bucket.long.length) _rateBuckets.delete(uid);
  }
}, 10 * 60 * 1000).unref?.();

// ── POST /api/office-chat/stream ──────────────────────────────────────────────
// SSE: envia a mensagem e recebe a resposta em streaming
router.post('/stream', authenticate, rateLimitChat, async (req, res) => {
  const { message, session_id, via_voice, screen } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Mensagem obrigatória.' });
  }

  // Configura SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Mantém conexão viva com heartbeat a cada 15s
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => clearInterval(heartbeat));

  try {
    await streamChat({
      req,
      res,
      userId: req.user.id,
      sessionId: session_id || null,
      userMessage: message.trim(),
      viaVoice: !!via_voice,
      screen,
    });
  } catch (err) {
    // Headers SSE já foram enviados — não dá para responder status HTTP; emite
    // o evento de erro padronizado para o front não ficar com o stream pendurado.
    console.error('[office-chat/stream] erro não tratado:', err?.message || err);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Desculpe, ocorreu um erro ao processar sua mensagem.' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } catch { /* conexão já fechada */ }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ── POST /api/office-chat/tts ─────────────────────────────────────────────────
// Síntese de voz via Gemini TTS — admin only para controlar custo de tokens.
// Body: { text: string, voice?: string }
// Retorna: audio/wav (binary)
const _ttsBuckets = new Map(); // userId -> { short: [ts], long: [ts] }
const TTS_LIMITS = {
  short: { windowMs: 60 * 1000,      max: 30 },   // 30 sínteses/min
  long:  { windowMs: 60 * 60 * 1000, max: 200 },  // 200 sínteses/hora
};
function rateLimitTTS(req, res, next) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Não autenticado.' });
  const now = Date.now();
  let bucket = _ttsBuckets.get(userId);
  if (!bucket) { bucket = { short: [], long: [] }; _ttsBuckets.set(userId, bucket); }
  if (pruneAndCount(bucket.short, TTS_LIMITS.short.windowMs, now) >= TTS_LIMITS.short.max)
    return res.status(429).json({ error: 'Limite curto de síntese atingido.' });
  if (pruneAndCount(bucket.long, TTS_LIMITS.long.windowMs, now) >= TTS_LIMITS.long.max)
    return res.status(429).json({ error: 'Limite horário de síntese atingido.' });
  bucket.short.push(now);
  bucket.long.push(now);
  next();
}

router.post('/tts', authenticate, requireAdmin, rateLimitTTS, async (req, res) => {
  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Texto obrigatório.' });
  }
  if (text.length > 600) {
    return res.status(400).json({ error: 'Texto longo demais (máx. 600 caracteres).' });
  }
  if (voice && !ALLOWED_VOICES.includes(voice)) {
    return res.status(400).json({ error: 'Voz inválida.', allowed: ALLOWED_VOICES });
  }

  try {
    const { audioBuffer, mimeType, durationMs, voice: usedVoice } =
      await synthesizeSpeech(text, { voice });

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('X-Eme-Voice', usedVoice);
    res.setHeader('X-Eme-Duration-Ms', String(durationMs));
    res.setHeader('Cache-Control', 'no-store');
    return res.send(audioBuffer);
  } catch (err) {
    console.error('[/tts]', err?.message || err);
    return res.status(502).json({ error: 'Falha ao sintetizar áudio.' });
  }
});

// ── GET /api/office-chat/sessions ─────────────────────────────────────────────
// Lista sessões do usuário (exceto deletadas)
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const sessions = await db.ChatSession.findAll({
      // As sessões da avaliação (context EVAL) são turnos de teste do admin,
      // não conversas dele.
      where: { user_id: req.user.id, deleted_at: null, context: { [db.Sequelize.Op.ne]: 'EVAL' } },
      order: [['updated_at', 'DESC']],
      limit: 50,
      attributes: ['id', 'title', 'is_favorited', 'total_bytes', 'created_at', 'updated_at'],
    });
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar sessões.' });
  }
});

// ── GET /api/office-chat/sessions/:id/messages ────────────────────────────────
// Carrega mensagens de uma sessão
router.get('/sessions/:id/messages', authenticate, async (req, res) => {
  try {
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });

    const messages = await db.ChatMessage.findAll({
      where: { session_id: session.id },
      order: [['created_at', 'ASC']],
      attributes: ['id', 'role', 'content', 'response_type', 'metadata', 'created_at'],
    });

    const messageIds = messages.map(m => m.id);
    const feedbacks = messageIds.length
      ? await db.ChatFeedback.findAll({
          where: { message_id: messageIds, user_id: req.user.id },
          attributes: ['message_id', 'rating'],
        })
      : [];
    const feedbackMap = Object.fromEntries(feedbacks.map(f => [f.message_id, f.rating]));

    const messagesWithFeedback = messages.map(m => ({
      ...m.toJSON(),
      feedback: feedbackMap[m.id] || null,
    }));

    res.json({ session, messages: messagesWithFeedback });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar mensagens.' });
  }
});

// ── PATCH /api/office-chat/sessions/:id/title ────────────────────────────────
// Renomear sessão
router.patch('/sessions/:id/title', authenticate, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório.' });
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
    await session.update({ title: title.trim() });
    res.json({ title: session.title });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao renomear sessão.' });
  }
});

// ── PATCH /api/office-chat/sessions/:id/favorite ─────────────────────────────
// Favoritar / desfavoritar sessão
router.patch('/sessions/:id/favorite', authenticate, async (req, res) => {
  try {
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });

    await session.update({ is_favorited: !session.is_favorited });
    res.json({ is_favorited: session.is_favorited });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao favoritar sessão.' });
  }
});

// ── DELETE /api/office-chat/sessions/:id ─────────────────────────────────────
// Soft delete (mantém dados, marca como excluída)
router.delete('/sessions/:id', authenticate, async (req, res) => {
  try {
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });

    await session.update({ deleted_at: new Date() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir sessão.' });
  }
});

// ── GET /api/office-chat/usage ────────────────────────────────────────────────
// Retorna o uso de armazenamento atual do usuário
router.get('/usage', authenticate, async (req, res) => {
  try {
    const bytes = await getUserStorageUsage(req.user.id);
    const limitBytes = 20 * 1024 * 1024;
    res.json({
      used_bytes: bytes,
      limit_bytes: limitBytes,
      used_mb: (bytes / 1024 / 1024).toFixed(2),
      limit_mb: 20,
      percent: Math.min(100, ((bytes / limitBytes) * 100).toFixed(1)),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar uso.' });
  }
});

// ── GET /api/office-chat/memories ─────────────────────────────────────────────
// Retorna memórias do usuário (para debug/transparência)
router.get('/memories', authenticate, async (req, res) => {
  try {
    const memories = await db.UserAIMemory.findAll({
      where: { user_id: req.user.id },
      order: [['updated_at', 'DESC']],
      attributes: ['id', 'key', 'value', 'category', 'source', 'enabled', 'updated_at'],
    });
    res.json({ memories });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar memórias.' });
  }
});

// ── POST /api/office-chat/memories ────────────────────────────────────────────
// A ÚNICA porta de entrada de uma memória: o clique da pessoa (card da Eme ou
// modal). A tool lembrar_preferencia só propõe - nunca chega aqui sozinha.
router.post('/memories', authenticate, async (req, res) => {
  try {
    const v = validarMemoria(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const source = req.body?.source === 'manual' ? 'manual' : 'chat';
    const [row, created] = await db.UserAIMemory.findOrCreate({
      where: { user_id: req.user.id, key: v.memoria.key },
      defaults: { ...v.memoria, user_id: req.user.id, source, enabled: true },
    });
    if (!created) await row.update({ value: v.memoria.value, category: v.memoria.category, source, enabled: true });
    res.status(created ? 201 : 200).json({ memory: row });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao guardar a preferência.' });
  }
});

// ── PUT /api/office-chat/memories/:id ─────────────────────────────────────────
router.put('/memories/:id', authenticate, async (req, res) => {
  try {
    const row = await db.UserAIMemory.findOne({ where: { id: req.params.id, user_id: req.user.id } });
    if (!row) return res.status(404).json({ error: 'Preferência não encontrada.' });
    const patch = {};
    if (req.body?.value !== undefined) {
      const v = validarMemoria({ key: row.key, value: req.body.value, category: req.body.category || row.category });
      if (!v.ok) return res.status(400).json({ error: v.erro });
      patch.value = v.memoria.value;
      patch.category = v.memoria.category;
    } else if (req.body?.category !== undefined && MEMORY_CATEGORIES.includes(req.body.category)) {
      patch.category = req.body.category;
    }
    if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
    await row.update(patch);
    res.json({ memory: row });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar a preferência.' });
  }
});

// ── GET/PUT /api/office-chat/me/settings ─────────────────────────────────────
// O que a pessoa configura da própria Eme (modal Configurações do chat).
router.get('/me/settings', authenticate, async (req, res) => {
  try {
    res.json({ settings: await userEmeSettings(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar as configurações.' });
  }
});

router.put('/me/settings', authenticate, async (req, res) => {
  try {
    const patch = {};
    if (req.body?.memory_enabled !== undefined) patch.memory_enabled = !!req.body.memory_enabled;
    if (req.body?.model_mode !== undefined) {
      if (!['auto', 'fast', 'smart'].includes(req.body.model_mode)) return res.status(400).json({ error: 'Modo inválido.' });
      patch.model_mode = req.body.model_mode;
    }
    if (req.body?.default_period !== undefined) {
      const v = req.body.default_period;
      if (v !== null && v !== '' && !PERIODO_KEYS.includes(v)) return res.status(400).json({ error: 'Período inválido.' });
      patch.default_period = v || null;
    }
    const [row] = await db.EmeUserSetting.findOrCreate({ where: { user_id: req.user.id }, defaults: { user_id: req.user.id, ...patch } });
    if (!row.isNewRecord) await row.update(patch);
    res.json({ settings: await userEmeSettings(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar as configurações.' });
  }
});

// ── DELETE /api/office-chat/memories/:key ─────────────────────────────────────
// Remove uma memória específica
router.delete('/memories/:key', authenticate, async (req, res) => {
  try {
    await db.UserAIMemory.destroy({
      where: { user_id: req.user.id, key: req.params.key },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover memória.' });
  }
});

// Monta um snapshot do raciocínio do assistente para uma mensagem avaliada.
// Inclui: pergunta original do usuário, texto puro da resposta, metadata
// (modelo, pool, ferramenta + argumentos, resumo do resultado, latência).
async function buildFeedbackContext(assistantMsg) {
  // Última mensagem do usuário antes desta resposta (na mesma sessão)
  const previousUserMsg = await db.ChatMessage.findOne({
    where: {
      session_id: assistantMsg.session_id,
      role: 'user',
      created_at: { [db.Sequelize.Op.lt]: assistantMsg.created_at },
    },
    order: [['created_at', 'DESC']],
    attributes: ['content', 'created_at'],
  });

  // Extrai apenas o texto da resposta (a parte action é JSON e fica grande)
  let assistantText = assistantMsg.content || '';
  if (assistantMsg.response_type !== 'text') {
    try { assistantText = JSON.parse(assistantMsg.content).text || ''; } catch { /* mantém */ }
  }

  const meta = assistantMsg.metadata || {};
  return {
    user_question:    previousUserMsg?.content || null,
    asked_at:         previousUserMsg?.created_at || null,
    assistant_text:   assistantText,
    response_type:    assistantMsg.response_type,
    model:            meta.model || null,
    pool:             meta.pool || null,
    latency_ms:       meta.latency_ms ?? null,
    tool_calls:       Array.isArray(meta.tool_calls) ? meta.tool_calls : [],
  };
}

// ── POST /api/office-chat/messages/:id/feedback ───────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/messages/:id/feedback', authenticate, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!['up', 'down'].includes(rating)) {
      return res.status(400).json({ error: 'Rating inválido.' });
    }

    if (!UUID_RE.test(req.params.id)) {
      return res.status(404).json({ error: 'Mensagem não encontrada.' });
    }

    const msg = await db.ChatMessage.findByPk(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });

    const session = await db.ChatSession.findOne({
      where: { id: msg.session_id, user_id: req.user.id },
    });
    if (!session) return res.status(403).json({ error: 'Acesso negado.' });

    // Snapshot do raciocínio: pergunta original + metadata da resposta (tool, args, modelo, latência)
    const context = await buildFeedbackContext(msg);

    await db.ChatFeedback.upsert(
      {
        message_id: req.params.id,
        session_id: msg.session_id,
        user_id: req.user.id,
        rating,
        comment: comment?.trim() || null,
        context,
      },
      { conflictFields: ['message_id', 'user_id'] },
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[officeChatRoutes] feedback error:', err);
    res.status(500).json({ error: 'Erro ao salvar feedback.' });
  }
});

// ── GET /api/office-chat/feedback ─────────────────────────────────────────────
// Painel admin: lista feedbacks com stats
router.get('/feedback', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });

    const { page = 1, per_page = 30, rating } = req.query;
    const offset = (Number(page) - 1) * Number(per_page);
    const where = {};
    if (rating) where.rating = rating;

    const { count, rows } = await db.ChatFeedback.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Number(per_page),
      offset,
    });

    const [upCount, downCount] = await Promise.all([
      db.ChatFeedback.count({ where: { rating: 'up' } }),
      db.ChatFeedback.count({ where: { rating: 'down' } }),
    ]);

    // Enriquecer com dados de usuário e mensagem via queries separadas
    const enriched = await Promise.all(rows.map(async (fb) => {
      const [user, message] = await Promise.all([
        db.User.findByPk(fb.user_id, { attributes: ['id', 'username', 'email', 'city'] }),
        db.ChatMessage.findByPk(fb.message_id, {
          attributes: ['id', 'content', 'response_type', 'session_id', 'metadata', 'created_at'],
        }),
      ]);
      const json = fb.toJSON();
      // Feedbacks antigos (anteriores ao snapshot) — reconstrói contexto a partir da msg, se ainda existir
      if (!json.context && message) {
        json.context = await buildFeedbackContext(message);
      }
      return { ...json, user, message };
    }));

    res.json({
      feedback: enriched,
      total: count,
      stats: { up: upCount, down: downCount, total: upCount + downCount },
    });
  } catch (err) {
    console.error('[officeChatRoutes] feedback list error:', err);
    res.status(500).json({ error: 'Erro ao listar feedbacks.' });
  }
});

// ── GET /api/office-chat/incidents ────────────────────────────────────────────
// Painel admin (Brain Studio > Validação): incidentes do validador anti-alucinação.
router.get('/incidents', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });

    const { page = 1, per_page = 30, outcome, reviewed } = req.query;
    const offset = (Number(page) - 1) * Number(per_page);
    const where = {};
    if (outcome) where.outcome = outcome;
    if (reviewed === 'true') where.reviewed = true;
    if (reviewed === 'false') where.reviewed = false;

    const { count, rows } = await db.EmeValidationIncident.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Number(per_page),
      offset,
    });

    const [correctedCount, blockedCount, warnedCount, pendingCount] = await Promise.all([
      db.EmeValidationIncident.count({ where: { outcome: 'corrected' } }),
      db.EmeValidationIncident.count({ where: { outcome: 'blocked' } }),
      db.EmeValidationIncident.count({ where: { outcome: 'warned' } }),
      db.EmeValidationIncident.count({ where: { reviewed: false } }),
    ]);

    const enriched = await Promise.all(rows.map(async (inc) => {
      const user = inc.user_id
        ? await db.User.findByPk(inc.user_id, { attributes: ['id', 'username', 'email', 'city'] })
        : null;
      return { ...inc.toJSON(), user };
    }));

    res.json({
      incidents: enriched,
      total: count,
      stats: {
        corrected: correctedCount,
        blocked: blockedCount,
        warned: warnedCount,
        pending: pendingCount,
        total: correctedCount + blockedCount + warnedCount,
      },
    });
  } catch (err) {
    console.error('[officeChatRoutes] incidents list error:', err);
    res.status(500).json({ error: 'Erro ao listar incidentes de validação.' });
  }
});

// ── PATCH /api/office-chat/incidents/:id ──────────────────────────────────────
// Triagem: admin marca/desmarca o incidente como revisado.
router.patch('/incidents/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Incidente não encontrado.' });

    const inc = await db.EmeValidationIncident.findByPk(req.params.id);
    if (!inc) return res.status(404).json({ error: 'Incidente não encontrado.' });

    if (typeof req.body?.reviewed === 'boolean') inc.reviewed = req.body.reviewed;
    await inc.save();
    res.json({ ok: true, reviewed: inc.reviewed });
  } catch (err) {
    console.error('[officeChatRoutes] incident review error:', err);
    res.status(500).json({ error: 'Erro ao atualizar incidente.' });
  }
});

export default router;
