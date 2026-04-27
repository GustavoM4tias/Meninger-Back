import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import db from '../models/sequelize/index.js';
import {
  streamChat,
  getUserStorageUsage,
  getOrCreateSession,
} from '../services/OfficeAI/OfficeChatService.js';

const router = express.Router();

// ── POST /api/office-chat/stream ──────────────────────────────────────────────
// SSE: envia a mensagem e recebe a resposta em streaming
router.post('/stream', authenticate, async (req, res) => {
  const { message, session_id } = req.body;

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
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ── GET /api/office-chat/sessions ─────────────────────────────────────────────
// Lista sessões do usuário (exceto deletadas)
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const sessions = await db.ChatSession.findAll({
      where: { user_id: req.user.id, deleted_at: null },
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
    const limitBytes = 30 * 1024 * 1024;
    res.json({
      used_bytes: bytes,
      limit_bytes: limitBytes,
      used_mb: (bytes / 1024 / 1024).toFixed(2),
      limit_mb: 30,
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
      attributes: ['id', 'key', 'value', 'category', 'updated_at'],
    });
    res.json({ memories });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar memórias.' });
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

    await db.ChatFeedback.upsert(
      {
        message_id: req.params.id,
        session_id: msg.session_id,
        user_id: req.user.id,
        rating,
        comment: comment?.trim() || null,
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
        db.ChatMessage.findByPk(fb.message_id, { attributes: ['id', 'content', 'response_type', 'session_id'] }),
      ]);
      return { ...fb.toJSON(), user, message };
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

export default router;
