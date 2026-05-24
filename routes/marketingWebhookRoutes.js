// routes/marketingWebhookRoutes.js
//
// Roteador SEPARADO para o webhook do Meta Lead Ads — o POST precisa do body
// como Buffer (raw) para validar o HMAC SHA-256. Montado ANTES do express.json()
// global no server.js (mesmo padrão do webhook do WhatsApp).

import express from 'express';
import { verifyMetaWebhook, receiveMetaWebhook } from '../controllers/marketing/metaWebhookController.js';

const router = express.Router();

router.get('/meta', verifyMetaWebhook);
router.post('/meta', express.raw({ type: '*/*', limit: '2mb' }), receiveMetaWebhook);

export default router;
