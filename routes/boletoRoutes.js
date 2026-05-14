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
    retryHistoryItem,
    listComissionRules,
    createComissionRule,
    updateComissionRule,
    deleteComissionRule,
} from '../controllers/boleto/boletoController.js';

const router = express.Router();

// ── Webhook público (chamado pelo CV, sem autenticação interna) ────────────────
router.post('/webhook', receiveWebhook);

// ── Simular webhook (dev/staging — bloqueado em produção pelo controller) ─────
router.post('/simulate', authenticate, requireAdmin, simulateWebhook);

// ── Configurações — somente admin ─────────────────────────────────────────────
router.get('/settings', authenticate, requireAdmin, getSettings);
router.patch('/settings', authenticate, requireAdmin, updateSettings);

// ── Regras de comissão por empreendimento — somente admin ─────────────────────
router.get('/comission-rules', authenticate, requireAdmin, listComissionRules);
router.post('/comission-rules', authenticate, requireAdmin, createComissionRule);
router.patch('/comission-rules/:id', authenticate, requireAdmin, updateComissionRule);
router.delete('/comission-rules/:id', authenticate, requireAdmin, deleteComissionRule);

// ── Histórico — usuário autenticado ───────────────────────────────────────────
router.get('/history', authenticate, listHistory);
router.get('/history/:id', authenticate, getHistoryItem);
router.post('/history/:id/retry', authenticate, requireAdmin, retryHistoryItem);

export default router;
