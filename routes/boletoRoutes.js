// routes/boletoRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
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

// Uma linha por AÇÃO da tela. A regra de cada ação (alçada x admin) está em
// lib/screenCapabilities.js — a mesma que a tela consulta para esconder a aba,
// então API e UI não têm como divergir.
//   view/operate → alçada da tela | configure → admin
// O histórico ainda passa pelo escopo de empreendimentos do usuário
// (services/boleto/boletoScope.js).
const BOLETO_SCREEN = '/financeiro/boleto-caixa';
const ver = [authenticate, requireCapability(BOLETO_SCREEN, 'view')];
const operar = [authenticate, requireCapability(BOLETO_SCREEN, 'operate')];
const verItem = [...ver, requireHistoryInScope];
const operarItem = [...operar, requireHistoryInScope];
const configurar = [authenticate, requireCapability(BOLETO_SCREEN, 'configure')];

// ── Webhook público (chamado pelo CV, sem autenticação interna) ────────────────
router.post('/webhook', receiveWebhook);

// ── Simular webhook (dev/staging — bloqueado em produção pelo controller) ─────
// configure = admin
router.post('/simulate', ...configurar, simulateWebhook);

// ── Configurações da automação ────────────────────────────────────────────────
router.get('/settings', ...configurar, getSettings);
router.patch('/settings', ...configurar, updateSettings);

// ── Regras de comissão por empreendimento ─────────────────────────────────────
router.get('/comission-rules', ...configurar, listComissionRules);
router.post('/comission-rules', ...configurar, createComissionRule);
router.patch('/comission-rules/:id', ...configurar, updateComissionRule);
router.delete('/comission-rules/:id', ...configurar, deleteComissionRule);

// ── WhatsApp Template ─────────────────────────────────────────────────────────
router.get('/whatsapp-template', ...configurar, getWhatsappTemplateStatus);
router.post('/whatsapp-template/sync', ...configurar, createBoletoWhatsappTemplate);

// ── Histórico e reprocessamento — alçada da tela ─────────────────────────────
// Leituras e ações de operação (reprocessar, regerar, reenviar, conferir
// pagamento) acompanham a alçada; o recorte por empreendimento é aplicado
// dentro do controller (listagens) e pelo requireHistoryInScope (item a item).
router.get('/history', ...ver, listHistory);
router.get('/history-stats', ...ver, getHistoryStats);
router.get('/history-facets', ...ver, getHistoryFacets);
router.get('/history/:id', ...verItem, getHistoryItem);
router.get('/history/:id/events', ...verItem, listHistoryEvents);
router.get('/history/:id/reserva-timeline', ...verItem, listReservaTimeline);
router.post('/history/:id/retry', ...operarItem, retryHistoryItem);
router.post('/history/:id/regenerate', ...operarItem, regenerateHistoryItem);
router.post('/history/:id/mark-cancelled', ...operarItem, markHistoryCancelled);
router.get('/history/:id/titular-contact', ...verItem, getTitularContact);
router.post('/history/:id/resend', ...operarItem, resendBoletoToTitular);
router.post('/history/:id/check-payment', ...operarItem, checkPaymentNow);

export default router;
