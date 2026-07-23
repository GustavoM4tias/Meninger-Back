// routes/reservaCancelRoutes.js — Cancelamento de Reservas (CV × Sienge)
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
    receiveWebhook,
    simulateWebhook,
    processManual,
    retryHistoryItem,
    getSettings,
    updateSettings,
    listHistory,
    getHistoryStats,
    getHistoryFacets,
    getHistoryItem,
    listHistoryEvents,
} from '../controllers/reservaCancel/reservaCancelController.js';

const router = express.Router();

// ── Webhook público (chamado pelo CV, sem autenticação interna) ────────────────
router.post('/webhook', receiveWebhook);

// ── Simular webhook (dev/staging — bloqueado em produção pelo controller) ─────
router.post('/simulate', authenticate, requireAdmin, simulateWebhook);

// ── Processamento manual / reprocesso — somente admin ─────────────────────────
router.post('/process', authenticate, requireAdmin, processManual);
router.post('/history/:id/retry', authenticate, requireAdmin, retryHistoryItem);

// ── Configurações — somente admin ─────────────────────────────────────────────
router.get('/settings', authenticate, requireAdmin, getSettings);
router.patch('/settings', authenticate, requireAdmin, updateSettings);

// ── Histórico — somente admin (tela é admin-only) ─────────────────────────────
router.get('/history', authenticate, requireAdmin, listHistory);
router.get('/history-stats', authenticate, requireAdmin, getHistoryStats);
router.get('/history-facets', authenticate, requireAdmin, getHistoryFacets);
router.get('/history/:id', authenticate, requireAdmin, getHistoryItem);
router.get('/history/:id/events', authenticate, requireAdmin, listHistoryEvents);

export default router;
