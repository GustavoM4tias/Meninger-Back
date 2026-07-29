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
    getHistoryStats,
    getHistoryFacets,
    getHistoryItem,
    listHistoryEvents,
    listReservaTimeline,
    checkPaymentNow,
    retryHistoryItem,
    regenerateHistoryItem,
    markHistoryCancelled,
    getTitularContact,
    resendBoletoToTitular,
    listComissionRules,
    createComissionRule,
    updateComissionRule,
    deleteComissionRule,
    getWhatsappTemplateStatus,
    createBoletoWhatsappTemplate,
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

// ── WhatsApp Template (admin) ─────────────────────────────────────────────────
router.get('/whatsapp-template', authenticate, requireAdmin, getWhatsappTemplateStatus);
router.post('/whatsapp-template/sync', authenticate, requireAdmin, createBoletoWhatsappTemplate);

// ── Histórico — tela /financeiro/boleto-caixa é admin-only ───────────────────
router.get('/history', authenticate, requireAdmin, listHistory);
router.get('/history-stats', authenticate, requireAdmin, getHistoryStats);
router.get('/history-facets', authenticate, requireAdmin, getHistoryFacets);
router.get('/history/:id', authenticate, requireAdmin, getHistoryItem);
router.get('/history/:id/events', authenticate, requireAdmin, listHistoryEvents);
router.get('/history/:id/reserva-timeline', authenticate, requireAdmin, listReservaTimeline);
router.post('/history/:id/retry', authenticate, requireAdmin, retryHistoryItem);
router.post('/history/:id/regenerate', authenticate, requireAdmin, regenerateHistoryItem);
router.post('/history/:id/mark-cancelled', authenticate, requireAdmin, markHistoryCancelled);
router.get('/history/:id/titular-contact', authenticate, requireAdmin, getTitularContact);
router.post('/history/:id/resend', authenticate, requireAdmin, resendBoletoToTitular);
router.post('/history/:id/check-payment', authenticate, requireAdmin, checkPaymentNow);

export default router;
