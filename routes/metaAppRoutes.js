// routes/metaAppRoutes.js
//
// API admin das credenciais de App do Meta (compartilhadas WhatsApp + Lead Ads).
// Montada em /api/meta-app (autenticada + admin).

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
    getConfig, updateConfig, testAppSecret,
    campaignsStatus, connectCampaigns, refreshCampaigns, disconnectCampaigns, campaignsOAuthUrl,
} from '../controllers/meta/metaAppConfigController.js';

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/config', getConfig);
router.put('/config', updateConfig);
router.post('/config/test', testAppSecret);

// Token de gestão de campanhas (admin — vê todas as contas de todos os BMs).
router.get('/campaigns/status', campaignsStatus);
router.post('/campaigns/connect', connectCampaigns);
router.post('/campaigns/refresh', refreshCampaigns);
router.post('/campaigns/disconnect', disconnectCampaigns);
router.get('/campaigns/oauth/url', campaignsOAuthUrl);

export default router;
