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
} from '../controllers/marketing/inboundLeadController.js';
import {
    listLeadForms, createLeadForm, updateLeadForm,
} from '../controllers/marketing/leadFormAdminController.js';

const router = express.Router();

// Toda a gestão de captação é admin-only.
router.use(authenticate, requireAdmin);

// Saúde da captação
router.get('/capture/health', captureHealth);

// Leads captados
router.get('/inbound-leads', listInboundLeads);
router.get('/inbound-leads/:id', getInboundLead);
router.post('/inbound-leads/:id/route', routeInboundLead);
router.post('/inbound-leads/:id/redispatch', redispatchInboundLead);
router.post('/inbound-leads/:id/mark-spam', markSpam);
router.post('/inbound-leads/:id/unmark-spam', unmarkSpam);

// Formulários de captação
router.get('/lead-forms', listLeadForms);
router.post('/lead-forms', createLeadForm);
router.put('/lead-forms/:id', updateLeadForm);

export default router;
