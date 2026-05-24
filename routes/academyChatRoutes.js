// routes/academyChatRoutes.js
//
// Eme no contexto ACADEMY — tutor de estudos. Reusa o OfficeChatService
// (mesma stack Gemini + SSE + sessões), mas com context='ACADEMY':
//   - prompt de tutor (sem dados operacionais)
//   - tools apenas do ToolRegistry (AcademyTools)
//   - toda tool call passa pelo SecureRunner (audit + permissão)
//
// Sessões ACADEMY e OFFICE coexistem na mesma tabela chat_sessions,
// distinguidas pela coluna `context`.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import db from '../models/sequelize/index.js';
import { streamChat } from '../services/OfficeAI/OfficeChatService.js';

const router = express.Router();

// ── Rate limit por usuário (mesma política do office-chat) ────────────────────
const RATE_LIMITS = {
  short: { windowMs: 60 * 1000, max: 15 },
  long: { windowMs: 60 * 60 * 1000, max: 200 },
};
const _rateBuckets = new Map();

function pruneAndCount(arr, windowMs, now) {
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return arr.length;
}

function rateLimitChat(req, res, next) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Não autenticado.' });

  const now = Date.now();
  let bucket = _rateBuckets.get(userId);
  if (!bucket) { bucket = { short: [], long: [] }; _rateBuckets.set(userId, bucket); }

  const shortCount = pruneAndCount(bucket.short, RATE_LIMITS.short.windowMs, now);
  const longCount = pruneAndCount(bucket.long, RATE_LIMITS.long.windowMs, now);

  if (shortCount >= RATE_LIMITS.short.max) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Muitas mensagens em sequência. Aguarde um instante.' });
  }
  if (longCount >= RATE_LIMITS.long.max) {
    res.set('Retry-After', '3600');
    return res.status(429).json({ error: 'Limite horário de mensagens atingido.' });
  }
  bucket.short.push(now);
  bucket.long.push(now);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, bucket] of _rateBuckets) {
    pruneAndCount(bucket.short, RATE_LIMITS.short.windowMs, now);
    pruneAndCount(bucket.long, RATE_LIMITS.long.windowMs, now);
    if (!bucket.short.length && !bucket.long.length) _rateBuckets.delete(uid);
  }
}, 10 * 60 * 1000).unref?.();

// ── POST /api/academy-chat/stream ─────────────────────────────────────────────
router.post('/stream', authenticate, rateLimitChat, async (req, res) => {
  const { message, session_id } = req.body;
  if (!message?.trim()) {
    return res.status(400).json({ error: 'Mensagem obrigatória.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));

  try {
    await streamChat({
      req,
      res,
      userId: req.user.id,
      sessionId: session_id || null,
      userMessage: message.trim(),
      context: 'ACADEMY', // 🔒 fixado pela rota — cliente não escolhe
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ── GET /api/academy-chat/sessions ────────────────────────────────────────────
// Lista APENAS sessões do contexto ACADEMY (não mistura com Office).
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const sessions = await db.ChatSession.findAll({
      where: { user_id: req.user.id, deleted_at: null, context: 'ACADEMY' },
      order: [['updated_at', 'DESC']],
      limit: 50,
      attributes: ['id', 'title', 'is_favorited', 'total_bytes', 'created_at', 'updated_at'],
    });
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar sessões.' });
  }
});

// ── GET /api/academy-chat/sessions/:id/messages ───────────────────────────────
router.get('/sessions/:id/messages', authenticate, async (req, res) => {
  try {
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null, context: 'ACADEMY' },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });

    const messages = await db.ChatMessage.findAll({
      where: { session_id: session.id },
      order: [['created_at', 'ASC']],
      attributes: ['id', 'role', 'content', 'response_type', 'metadata', 'created_at'],
    });
    res.json({ session, messages });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar mensagens.' });
  }
});

// ── PATCH /api/academy-chat/sessions/:id/title ────────────────────────────────
// Renomear uma conversa.
router.patch('/sessions/:id/title', authenticate, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório.' });
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null, context: 'ACADEMY' },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
    await session.update({ title: title.trim() });
    res.json({ title: session.title });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao renomear sessão.' });
  }
});

// ── PATCH /api/academy-chat/sessions/:id/favorite ─────────────────────────────
// Favoritar / desfavoritar uma conversa.
router.patch('/sessions/:id/favorite', authenticate, async (req, res) => {
  try {
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null, context: 'ACADEMY' },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
    await session.update({ is_favorited: !session.is_favorited });
    res.json({ is_favorited: session.is_favorited });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao favoritar sessão.' });
  }
});

// ── DELETE /api/academy-chat/sessions/:id ─────────────────────────────────────
router.delete('/sessions/:id', authenticate, async (req, res) => {
  try {
    const session = await db.ChatSession.findOne({
      where: { id: req.params.id, user_id: req.user.id, deleted_at: null, context: 'ACADEMY' },
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
    await session.update({ deleted_at: new Date() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir sessão.' });
  }
});

export default router;
