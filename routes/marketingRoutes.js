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
    listCvEnterprises, reconcileWithCv,
} from '../controllers/marketing/inboundLeadController.js';
import {
    listLeadForms, createLeadForm, updateLeadForm,
    toggleActive as toggleLeadFormActive,
    listLeadFormLeads,
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
    recentLeads as metaFormRecentLeads,
    comparison as metaFormComparison,
    exportCsv as metaFormExportCsv,
    fieldMappingEditor as metaFormFieldMappingEditor,
    updateFieldMappings as metaFormUpdateFieldMappings,
} from '../controllers/marketing/metaLeadFormController.js';
import {
    list as listMetaCampaigns,
    sync as syncMetaCampaigns,
    detail as metaCampaignDetail,
    campaignLeads as metaCampaignLeads,
    dailyBreakdown as metaCampaignDaily,
    update as updateMetaCampaign,
    importHistoricalLeads as importHistoricalMetaLeads,
    reconcileHistoricalWithCv,
    reparseExistingLeads as reparseMetaLeads,
    migrateMappingsFormToCampaign,
    campaignAds as listMetaCampaignAds,
    syncCampaignAds as syncMetaCampaignAds,
    listAllAds as listAllMetaAds,
    campaignAdSets as listMetaCampaignAdSets,
    runFullSync as runMetaFullSync,
} from '../controllers/marketing/metaCampaignController.js';

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
router.post('/inbound-leads/:id/reconcile-cv', reconcileWithCv);

// Formulários de captação (internos — LPs do site)
router.get('/lead-forms', listLeadForms);
router.post('/lead-forms', createLeadForm);
router.put('/lead-forms/:id', updateLeadForm);
router.post('/lead-forms/:id/toggle-active', toggleLeadFormActive);
router.get('/lead-forms/:id/leads', listLeadFormLeads);

// Formulários Meta Lead Ads (cache local + mapping → empreendimento)
router.get('/meta-forms', listMetaForms);
router.post('/meta-forms/sync', syncMetaForms);
router.put('/meta-forms/:id/mapping', updateMetaFormMapping);
router.get('/meta-forms/:id/leads', metaFormRecentLeads);
router.get('/meta-forms/:id/comparison', metaFormComparison);
router.get('/meta-forms/:id/leads.csv', metaFormExportCsv);
router.get('/meta-forms/:id/field-mappings', metaFormFieldMappingEditor);
router.put('/meta-forms/:id/field-mappings', metaFormUpdateFieldMappings);

// Campanhas Meta (cache local + insights de gasto/leads/CAC)
router.get('/meta-campaigns', listMetaCampaigns);
router.post('/meta-campaigns/sync', syncMetaCampaigns);
router.get('/meta-campaigns/:id', metaCampaignDetail);
router.get('/meta-campaigns/:id/leads', metaCampaignLeads);
router.get('/meta-campaigns/:id/daily', metaCampaignDaily);
router.put('/meta-campaigns/:id', updateMetaCampaign);
router.post('/meta-campaigns/import-historical', importHistoricalMetaLeads);
router.post('/meta-campaigns/reconcile-cv-batch', reconcileHistoricalWithCv);
router.post('/meta-campaigns/reparse-existing', reparseMetaLeads);
router.post('/meta-campaigns/migrate-mappings', migrateMappingsFormToCampaign);
router.get('/meta-ads', listAllMetaAds);                              // todos os ads (cache)
router.post('/sync/full', runMetaFullSync);                           // varre tudo manualmente (admin)
router.get('/meta-campaigns/:id/ads', listMetaCampaignAds);
router.get('/meta-campaigns/:id/adsets', listMetaCampaignAdSets);
router.post('/meta-campaigns/:id/ads/sync', syncMetaCampaignAds);

export default router;
