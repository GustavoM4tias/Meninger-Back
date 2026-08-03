// routes/emeReportsRoutes.js
//
// Relatórios da Eme (relatórios customizados gerados por IA).
// Geração/edição: admin-only (alçada inicial). Visualização interna: dono,
// admins e quem estiver na lista de acesso do relatório.

import express from 'express';
import { Op } from 'sequelize';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import db from '../models/sequelize/index.js';
import {
  normalizeSpec, canEdit, canView, listForUser, publish, getPublishedPayload,
  setInternalAccess, enablePublic, revokePublic, rotatePublicToken, renewPublic,
  scanPii, publicExposureSummary,
  listTrash, deletionImpact, softDelete, restore, purge, TRASH_RETENTION_DAYS,
  dismissForUser, undismissForUser, listOrphans, transferOwnership,
} from '../services/emeReports/ReportService.js';
import { streamReportChat } from '../services/emeReports/ReportChatService.js';
import {
  listMemories, remember, updateMemory, deleteMemory,
} from '../services/emeReports/ReportMemoryService.js';

const router = express.Router();
router.use(authenticate);

// Temas visuais aceitos (espelha front: components/Reports/themes.js)
// Espelha as chaves de Meninger-Front/src/components/Reports/themes.js.
// Tema novo no front → adicionar aqui, senão o PUT recusa em silêncio.
const THEMES = [
  'classic', 'modern', 'executive', 'vibrant', 'nature',
  'ocean', 'sunset', 'berry', 'citrus', 'minimal',
];

// Rate limit do chat do builder (in-memory, mesmo padrão do office-chat)
const _buckets = new Map();
function rateLimitChat(req, res, next) {
  const now = Date.now();
  const arr = _buckets.get(req.user.id) || [];
  while (arr.length && now - arr[0] > 60 * 1000) arr.shift();
  if (arr.length >= 10) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Muitas mensagens em sequência. Aguarde um instante.' });
  }
  arr.push(now);
  _buckets.set(req.user.id, arr);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [uid, arr] of _buckets) {
    while (arr.length && now - arr[0] > 60 * 1000) arr.shift();
    if (!arr.length) _buckets.delete(uid);
  }
}, 10 * 60 * 1000).unref?.();

async function loadReport(req, res) {
  const report = await db.EmeGeneratedReport.findByPk(req.params.id);
  if (!report) {
    res.status(404).json({ error: 'Relatório não encontrado.' });
    return null;
  }
  return report;
}

// ── Listagem / CRUD ──────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { own, shared } = await listForUser(req.user);
    res.json({ own, shared, isAdmin: req.user.role === 'admin' });
  } catch (err) {
    console.error('[emeReports] list:', err);
    res.status(500).json({ error: 'Falha ao listar relatórios.' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const report = await db.EmeGeneratedReport.create({
      ownerId: req.user.id,
      title: String(req.body?.title || 'Novo relatório').slice(0, 200),
      dataMode: req.body?.data_mode === 'live' ? 'live' : 'fixed',
    });
    res.status(201).json(report);
  } catch (err) {
    console.error('[emeReports] create:', err);
    res.status(500).json({ error: 'Falha ao criar relatório.' });
  }
});

// Builder: relatório completo + thread da conversa
router.get('/:id', async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  if (report.deletedAt) return res.status(410).json({ error: 'Este relatório está na lixeira. Restaure-o para editar.' });
  const messages = await db.EmeGeneratedReportMessage.findAll({
    where: { reportId: report.id },
    order: [['created_at', 'ASC']],
    limit: 80,
  });
  const access = await db.EmeGeneratedReportAccess.findAll({ where: { reportId: report.id } });
  res.json({ report, messages, access });
});

// Visualização (dono/admin/compartilhado): sempre a versão publicada
router.get('/:id/view', async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!(await canView(report, req.user))) return res.status(403).json({ error: 'Sem permissão.' });
  const isEditor = canEdit(report, req.user);
  const payload = isEditor && report.status === 'draft'
    ? { spec: report.spec, dataSnapshot: report.dataSnapshot, version: null, publishedAt: null }
    : await getPublishedPayload(report);
  res.json({
    id: report.id,
    title: report.title,
    enterpriseName: report.enterpriseName,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    dataMode: report.dataMode,
    theme: report.theme,
    status: report.status,
    visibility: report.visibility,
    refreshedAt: report.refreshedAt,
    canEdit: isEditor,
    ...payload,
  });
});

router.put('/:id', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  const patch = {};
  if (req.body?.title) patch.title = String(req.body.title).slice(0, 200);
  if (req.body?.spec) patch.spec = normalizeSpec(req.body.spec);
  if (req.body?.theme && THEMES.includes(req.body.theme)) patch.theme = req.body.theme;
  if (req.body?.data_mode && ['fixed', 'live'].includes(req.body.data_mode)) patch.dataMode = req.body.data_mode;
  if ('period_start' in (req.body || {})) patch.periodStart = req.body.period_start || null;
  if ('period_end' in (req.body || {})) patch.periodEnd = req.body.period_end || null;
  if ('enterprise_name' in (req.body || {})) patch.enterpriseName = req.body.enterprise_name || null;
  await report.update(patch);
  res.json(report);
});

// O que será perdido — o front mostra antes de confirmar a exclusão
router.get('/:id/deletion-impact', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  res.json(await deletionImpact(report));
});

// Exclusão vai para a LIXEIRA (reversível por 30 dias). O link público morre
// imediatamente — não faz sentido continuar exposto depois de excluído.
router.delete('/:id', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  await softDelete(report, req.user);
  res.json({ ok: true, restorableUntilDays: TRASH_RETENTION_DAYS });
});

router.get('/trash/all', requireAdmin, async (req, res) => {
  res.json(await listTrash(req.user));
});

router.post('/:id/restore', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  await restore(report);
  res.json({ ok: true, report });
});

// Exclusão definitiva (esvaziar lixeira item a item)
router.delete('/:id/purge', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  if (!report.deletedAt) return res.status(400).json({ error: 'Mova para a lixeira antes de excluir definitivamente.' });
  await purge(report);
  res.json({ ok: true });
});

// ── Propriedade: relatórios sem responsável ativo ────────────────────────────
// Nada é reatribuído sozinho: o relatório continua visível para quem tem
// acesso, e um admin decide para quem vai a responsabilidade de editar.

router.get('/orphans/all', requireAdmin, async (req, res) => {
  res.json(await listOrphans());
});

router.post('/:id/transfer', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  const result = await transferOwnership(report, Number(req.body?.user_id), {
    keepPreviousAccess: req.body?.keep_previous_access !== false,
  });
  if (result?.error) return res.status(400).json(result);
  res.json(result);
});

// ── Compartilhado comigo: sair da própria lista ──────────────────────────────
// NÃO exige admin: quem recebeu precisa poder se livrar do item, inclusive
// quando o acesso veio por cargo (aí não há linha individual para remover).
router.post('/:id/dismiss', async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!(await canView(report, req.user))) return res.status(403).json({ error: 'Sem permissão.' });
  if (report.ownerId === req.user.id) {
    return res.status(400).json({ error: 'Você é o dono deste relatório - use a exclusão.' });
  }
  await dismissForUser(report.id, req.user.id);
  res.json({ ok: true });
});

// Desfazer (o front oferece logo depois de remover)
router.delete('/:id/dismiss', async (req, res) => {
  await undismissForUser(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Chat do builder (SSE) ────────────────────────────────────────────────────

router.post('/:id/chat', requireAdmin, rateLimitChat, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Mensagem obrigatória.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));

  try {
    await streamReportChat({
      req, res,
      user: req.user,
      report,
      userMessage: message,
      selectedBlockIds: Array.isArray(req.body?.selected_block_ids) ? req.body.selected_block_ids : [],
    });
  } catch (err) {
    console.error('[emeReports] chat:', err);
    try { res.write(`data: ${JSON.stringify({ type: 'error', message: 'Erro inesperado.' })}\n\n`); } catch { /* conexão fechada */ }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ── Publicação / versões ─────────────────────────────────────────────────────

router.post('/:id/publish', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  if (!(report.spec?.blocks || []).length) return res.status(400).json({ error: 'Relatório vazio — monte-o com a Eme antes de publicar.' });
  const version = await publish(report, req.user);
  res.json({ ok: true, version });
});

// ── Compartilhamento interno ─────────────────────────────────────────────────

router.post('/:id/share', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  const userIds = (req.body?.user_ids || []).map(Number).filter(Boolean);
  const positions = (req.body?.positions || []).map(String).filter(Boolean);
  await setInternalAccess(report, { userIds, positions }, req.user);
  res.json({ ok: true });
});

// Opções para o modal de compartilhamento
router.get('/:id/share-options', requireAdmin, async (req, res) => {
  // Só usuários ativos: compartilhar com quem saiu da empresa não faz sentido
  const users = await db.User.findAll({
    attributes: ['id', 'username', 'position'],
    where: { role: { [Op.ne]: null }, status: true },
    order: [['username', 'ASC']],
    limit: 500,
  });
  const positions = [...new Set(users.map((u) => u.position).filter(Boolean))].sort();
  res.json({ users, positions });
});

// ── Link público (segurança máxima) ──────────────────────────────────────────

// Passo 1+2 do modal: resumo do que será exposto + scan de PII
router.get('/:id/public-check', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  res.json({
    summary: publicExposureSummary(report),
    piiFindings: scanPii(report),
    currentToken: report.publicToken ? true : false,
    expiresAt: report.publicExpiresAt,
  });
});

router.post('/:id/public', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  if (report.status !== 'published') return res.status(400).json({ error: 'Publique o relatório antes de gerar o link público.' });
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Confirmação obrigatória.' });

  // PII detectada exige reconhecimento explícito extra
  const findings = scanPii(report);
  if (findings.length && req.body?.pii_acknowledged !== true) {
    return res.status(409).json({ error: 'Conteúdo sensível detectado.', piiFindings: findings });
  }

  const token = await enablePublic(report, { expiresInDays: req.body?.expires_in_days });
  res.json({ ok: true, token, expiresAt: report.publicExpiresAt });
});

router.post('/:id/public/rotate', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user) || report.visibility !== 'public') return res.status(403).json({ error: 'Sem permissão.' });
  const token = await rotatePublicToken(report);
  res.json({ ok: true, token });
});

router.post('/:id/public/renew', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user) || report.visibility !== 'public') return res.status(403).json({ error: 'Sem permissão.' });
  await renewPublic(report, { expiresInDays: req.body?.expires_in_days });
  res.json({ ok: true, expiresAt: report.publicExpiresAt });
});

router.delete('/:id/public', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  await revokePublic(report, { downgradeTo: req.body?.downgrade_to === 'private' ? 'private' : 'internal' });
  res.json({ ok: true });
});

// Auditoria do link público (dono)
router.get('/:id/public-log', requireAdmin, async (req, res) => {
  const report = await loadReport(req, res);
  if (!report) return;
  if (!canEdit(report, req.user)) return res.status(403).json({ error: 'Sem permissão.' });
  const logs = await db.EmeGeneratedReportPublicLog.findAll({
    where: { reportId: report.id },
    order: [['created_at', 'DESC']],
    limit: 200,
  });
  res.json({ views: report.publicViews, logs });
});

// ── Memória dos relatórios ───────────────────────────────────────────────────
// Preferências GERAIS de como o usuário quer seus relatórios. Valem para todos;
// a Eme lê no início de cada conversa e grava o que o usuário declarar.

router.get('/memories/all', requireAdmin, async (req, res) => {
  res.json(await listMemories(req.user.id));
});

router.post('/memories/all', requireAdmin, async (req, res) => {
  const result = await remember({ userId: req.user.id, text: req.body?.text, source: 'user' });
  if (result?.error) return res.status(400).json(result);
  res.json(await listMemories(req.user.id));
});

router.put('/memories/all/:memoryId', requireAdmin, async (req, res) => {
  const row = await updateMemory(req.params.memoryId, req.user.id, req.body || {});
  if (!row) return res.status(404).json({ error: 'Memória não encontrada.' });
  res.json(await listMemories(req.user.id));
});

router.delete('/memories/all/:memoryId', requireAdmin, async (req, res) => {
  const ok = await deleteMemory(req.params.memoryId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Memória não encontrada.' });
  res.json(await listMemories(req.user.id));
});

// ── Painel admin: blocos custom (pipeline de promoção) ───────────────────────

router.get('/admin/custom-blocks', requireAdmin, async (req, res) => {
  const rows = await db.EmeGeneratedReportCustomBlock.findAll({
    order: [['use_count', 'DESC'], ['updated_at', 'DESC']],
    limit: 200,
  });
  res.json(rows);
});

router.put('/admin/custom-blocks/:blockId', requireAdmin, async (req, res) => {
  const row = await db.EmeGeneratedReportCustomBlock.findByPk(req.params.blockId);
  if (!row) return res.status(404).json({ error: 'Bloco não encontrado.' });
  const patch = {};
  if (['em_uso', 'promovido', 'descartado'].includes(req.body?.status)) patch.status = req.body.status;
  if ('review_note' in (req.body || {})) patch.reviewNote = req.body.review_note || null;
  await row.update(patch);
  res.json(row);
});

export default router;
