// routes/whatsappWebhookRoutes.js
//
// Roteador SEPARADO do whatsappRoutes porque o POST do webhook precisa
// receber o body como Buffer (raw) para conseguirmos validar o HMAC SHA-256.
// Esse roteador é montado ANTES do express.json() global no server.js.

import express from 'express';
import { verify, receive } from '../controllers/whatsapp/whatsappWebhookController.js';

const router = express.Router();

router.get('/', verify);
router.post('/', express.raw({ type: '*/*', limit: '2mb' }), receive);

export default router;
