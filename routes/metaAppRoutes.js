// routes/metaAppRoutes.js
//
// API admin das credenciais de App do Meta (compartilhadas WhatsApp + Lead Ads).
// Montada em /api/meta-app (autenticada + admin).

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import { getConfig, updateConfig, testAppSecret } from '../controllers/meta/metaAppConfigController.js';

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/config', getConfig);
router.put('/config', updateConfig);
router.post('/config/test', testAppSecret);

export default router;
