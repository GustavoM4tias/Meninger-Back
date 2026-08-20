// routes/reservaCancelRoutes.js — Cancelamento de Reservas (CV × Sienge)
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import { requireCancelInScope } from '../services/reservaCancel/reservaCancelScope.js';
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

// Uma linha por AÇÃO da tela (regra em lib/screenCapabilities.js, a mesma que a
// tela consulta): view/operate seguem a alçada do Comercial, configure é admin.
// O histórico ainda passa pelo escopo de empreendimentos do usuário
// (services/reservaCancel/reservaCancelScope.js).
const CANCEL_SCREEN = '/comercial/cancelamento-reservas';
const ver = [authenticate, requireCapability(CANCEL_SCREEN, 'view')];
const operar = [authenticate, requireCapability(CANCEL_SCREEN, 'operate')];
const verItem = [...ver, requireCancelInScope];
const operarItem = [...operar, requireCancelInScope];
const configurar = [authenticate, requireCapability(CANCEL_SCREEN, 'configure')];

// ── Webhook público (chamado pelo CV, sem autenticação interna) ────────────────
router.post('/webhook', receiveWebhook);

// ── Simular webhook (dev/staging — bloqueado em produção pelo controller) ─────
router.post('/simulate', ...configurar, simulateWebhook);

// ── Processamento manual avulso (qualquer idreserva) — somente admin ──────────
// Diferente do retry: não parte de um caso do histórico, então não tem escopo
// onde se ancorar.
router.post('/process', ...configurar, processManual);

// ── Reprocessar um caso do histórico — alçada da tela ─────────────────────────
router.post('/history/:id/retry', ...operarItem, retryHistoryItem);

// ── Configurações — somente admin ─────────────────────────────────────────────
router.get('/settings', ...configurar, getSettings);
router.patch('/settings', ...configurar, updateSettings);

// ── Histórico — alçada da tela, recortado por empreendimento ──────────────────
router.get('/history', ...ver, listHistory);
router.get('/history-stats', ...ver, getHistoryStats);
router.get('/history-facets', ...ver, getHistoryFacets);
router.get('/history/:id', ...verItem, getHistoryItem);
router.get('/history/:id/events', ...verItem, listHistoryEvents);

export default router;
