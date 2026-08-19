// routes/boletoRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import { requireHistoryInScope } from '../services/boleto/boletoScope.js';
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

// Alçada da tela: histórico, filtros e reprocessamento são DELEGÁVEIS por
// alçada (a aba Configurações some para quem não é admin, e as rotas de
// configuração abaixo continuam exigindo admin). O histórico ainda passa pelo
// escopo de empreendimentos do usuário — ver services/boleto/boletoScope.js.
const BOLETO_SCREEN = '/financeiro/boleto-caixa';
const operar = [authenticate, requireRoutePermission([BOLETO_SCREEN])];
const operarItem = [...operar, requireHistoryInScope];

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

// ── Histórico e reprocessamento — alçada da tela ─────────────────────────────
// Leituras e ações de operação (reprocessar, regerar, reenviar, conferir
// pagamento) acompanham a alçada; o recorte por empreendimento é aplicado
// dentro do controller (listagens) e pelo requireHistoryInScope (item a item).
router.get('/history', ...operar, listHistory);
router.get('/history-stats', ...operar, getHistoryStats);
router.get('/history-facets', ...operar, getHistoryFacets);
router.get('/history/:id', ...operarItem, getHistoryItem);
router.get('/history/:id/events', ...operarItem, listHistoryEvents);
router.get('/history/:id/reserva-timeline', ...operarItem, listReservaTimeline);
router.post('/history/:id/retry', ...operarItem, retryHistoryItem);
router.post('/history/:id/regenerate', ...operarItem, regenerateHistoryItem);
router.post('/history/:id/mark-cancelled', ...operarItem, markHistoryCancelled);
router.get('/history/:id/titular-contact', ...operarItem, getTitularContact);
router.post('/history/:id/resend', ...operarItem, resendBoletoToTitular);
router.post('/history/:id/check-payment', ...operarItem, checkPaymentNow);

export default router;
