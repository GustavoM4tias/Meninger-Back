// routes/marketingRoutes.js
//
// API admin da captação de marketing. Montada em /api/marketing (autenticada).
// Os endpoints PÚBLICOS (formulário, webhook Meta) ficam em routers separados
// montados antes do express.json() — ver marketingPublicRoutes / marketingWebhookRoutes.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
    listInboundLeads, getInboundLead, routeInboundLead,
    redispatchInboundLead, markSpam, unmarkSpam, captureHealth,
    listCvEnterprises,
} from '../controllers/marketing/inboundLeadController.js';
import {
    listLeadForms, createLeadForm, updateLeadForm,
} from '../controllers/marketing/leadFormAdminController.js';
import {
    getConfig as getMarketingConfig,
    updateConfig as updateMarketingConfig,
    generateVerifyToken,
    testMetaConnection,
} from '../controllers/marketing/marketingConfigController.js';
import {
    list as listMetaForms,
    sync as syncMetaForms,
    updateMapping as updateMetaFormMapping,
} from '../controllers/marketing/metaLeadFormController.js';

const router = express.Router();

// Toda a gestão de captação é admin-only.
router.use(authenticate, requireAdmin);

// Saúde da captação
router.get('/capture/health', captureHealth);

// Empreendimentos do CV (multiselects)
router.get('/cv-enterprises', listCvEnterprises);

// Configuração da captação (Geral + Meta Lead Ads)
router.get('/config', getMarketingConfig);
router.put('/config', updateMarketingConfig);
router.post('/config/generate-verify-token', generateVerifyToken);
router.post('/config/meta-test', testMetaConnection);

// Leads captados
router.get('/inbound-leads', listInboundLeads);
router.get('/inbound-leads/:id', getInboundLead);
router.post('/inbound-leads/:id/route', routeInboundLead);
router.post('/inbound-leads/:id/redispatch', redispatchInboundLead);
router.post('/inbound-leads/:id/mark-spam', markSpam);
router.post('/inbound-leads/:id/unmark-spam', unmarkSpam);

// Formulários de captação (internos — LPs do site)
router.get('/lead-forms', listLeadForms);
router.post('/lead-forms', createLeadForm);
router.put('/lead-forms/:id', updateLeadForm);

// Formulários Meta Lead Ads (cache local + mapping → empreendimento)
router.get('/meta-forms', listMetaForms);
router.post('/meta-forms/sync', syncMetaForms);
router.put('/meta-forms/:id/mapping', updateMetaFormMapping);

export default router;
