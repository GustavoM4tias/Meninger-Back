// routes/boletoRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
    receiveWebhook,
    simulateWebhook,
    getSettings,
    updateSettings,
    listHistory,
    getHistoryItem,
} from '../controllers/boleto/boletoController.js';

const router = express.Router();

// ── Webhook público (chamado pelo CV, sem autenticação interna) ────────────────
router.post('/webhook', receiveWebhook);

// ── Simular webhook (dev/staging — bloqueado em produção pelo controller) ─────
router.post('/simulate', authenticate, requireAdmin, simulateWebhook);

// ── Configurações — somente admin ─────────────────────────────────────────────
router.get('/settings', authenticate, requireAdmin, getSettings);
router.patch('/settings', authenticate, requireAdmin, updateSettings);

// ── Histórico — usuário autenticado ───────────────────────────────────────────
router.get('/history', authenticate, listHistory);
router.get('/history/:id', authenticate, getHistoryItem);

export default router;
