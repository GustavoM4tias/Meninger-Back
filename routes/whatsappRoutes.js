// routes/whatsappRoutes.js
//
// Atenção: o webhook precisa receber o RAW body para validar a assinatura HMAC.
// Por isso ele é montado em um arquivo separado (whatsappWebhookRoutes.js) que
// é registrado ANTES do express.json() global no server.js.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

import {
    getConfig, updateConfig, healthCheck, syncTemplates, testSend,
    discover, applyDiscovered, registerPhone,
} from '../controllers/whatsapp/whatsappConfigController.js';
import {
    listTemplates, getTemplate, createTemplate, deleteTemplate,
} from '../controllers/whatsapp/whatsappTemplateController.js';
import {
    listMessages, stats,
} from '../controllers/whatsapp/whatsappMessageController.js';
import {
    getPublicInfo, getCoverage,
} from '../controllers/whatsapp/whatsappAudienceController.js';

const router = express.Router();

// ── Config (admin) ──────────────────────────────────────────────────────
router.get('/config',                       authenticate, requireAdmin, getConfig);
router.put('/config',                       authenticate, requireAdmin, updateConfig);
router.post('/config/health',               authenticate, requireAdmin, healthCheck);
router.post('/config/sync-templates',       authenticate, requireAdmin, syncTemplates);
router.post('/config/test-send',            authenticate, requireAdmin, testSend);
router.post('/config/register-phone',       authenticate, requireAdmin, registerPhone);
router.post('/config/discover',             authenticate, requireAdmin, discover);
router.post('/config/apply-discovered',     authenticate, requireAdmin, applyDiscovered);

// ── Templates (admin) ───────────────────────────────────────────────────
router.get('/templates',          authenticate, requireAdmin, listTemplates);
router.post('/templates',         authenticate, requireAdmin, createTemplate);
router.get('/templates/:id',      authenticate, requireAdmin, getTemplate);
router.delete('/templates/:name', authenticate, requireAdmin, deleteTemplate);

// ── Mensagens / log (admin) ─────────────────────────────────────────────
router.get('/messages',           authenticate, requireAdmin, listMessages);
router.get('/messages/stats',     authenticate, requireAdmin, stats);

// ── Info pública do número do sistema (qualquer user autenticado) ───────
router.get('/info',               authenticate, getPublicInfo);

// ── Cobertura do canal: quem está sem telefone e não recebe (admin) ─────
// O opt-in foi removido em 2026-08-17 — estar no Office já autoriza o canal.
router.get('/coverage',           authenticate, requireAdmin, getCoverage);

export default router;
