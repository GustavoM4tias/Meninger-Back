// routes/conditionsRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import * as ctrl from '../controllers/comercial/enterpriseConditionController.js';
import * as ds from '../controllers/comercial/docusignController.js';

const router = express.Router();
router.use(authenticate);

// ── Configurações (admin) ─────────────────────────────────────────────────────
router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);

// ── Permissões do usuário atual (editar/autorizar) ────────────────────────────
router.get('/permissions', ctrl.getMyPermissions);

// ── Listagem e criação ────────────────────────────────────────────────────────
router.get('/', ctrl.listConditions);
router.post('/', ctrl.createCondition);             // admin only (guard no controller)

// ── Auxiliares (sem :id numérico — devem vir ANTES das rotas /:id) ────────────
router.get('/correspondents', ctrl.listCorrespondents);
router.get('/correspondents/companies', ctrl.listCorrespondentCompanies);
router.get('/office-users', ctrl.listOfficeUsers);
router.get('/cost-report', ctrl.getCostReport);     // relatório consolidado Menin x cliente (gestão)

// ── DocuSign: settings (admin) + assinatura por ficha ────────────────────────
router.get('/docusign-settings', ds.getDocusignSettings);
router.put('/docusign-settings', ds.updateDocusignSettings);
router.get('/docusign/consent-url', ds.getDocusignConsentUrl);
router.post('/docusign/test', ds.testDocusign);
router.post('/docusign/oauth-url', ds.getDocusignOauthUrl);   // login "Conectar com DocuSign" (admin)
router.post('/docusign/disconnect', ds.disconnectDocusign);   // limpa a sessão do login (admin)

// ── Biblioteca de campanhas (modelos reutilizáveis) ──────────────────────────
router.get('/campaign-templates', ctrl.listCampaignTemplates);
router.post('/campaign-templates', ctrl.createCampaignTemplate);
router.patch('/campaign-templates/:id(\\d+)', ctrl.updateCampaignTemplate);
router.get('/campaign-templates/:id(\\d+)/usage', ctrl.getCampaignTemplateUsage);
router.get('/enterprise/:idempreendimento/price-tables', ctrl.getPriceTablesForEnterprise);
router.get('/enterprise/:idempreendimento/price-distribution', ctrl.getPriceDistributionForEnterprise);
router.get('/enterprise/:idempreendimento/modules', ctrl.listModulesForEnterprise);
router.get('/enterprise/:idempreendimento/stages', ctrl.getStagesForEnterprise);
router.get('/enterprise/:idempreendimento/stages/:idetapa/units', ctrl.getUnitsForStage);

// ── CRUD por ficha ────────────────────────────────────────────────────────────
router.get('/:id(\\d+)', ctrl.getCondition);
router.get('/:id(\\d+)/cost-summary', ctrl.getConditionCostSummary); // custos por pagador da ficha
router.patch('/:id(\\d+)', ctrl.updateCondition);           // admin only, não-approved

// ── Fluxo de aprovação ────────────────────────────────────────────────────────
router.post('/:id(\\d+)/submit', ctrl.submitForApproval);         // draft → pending_approval (editor)
router.post('/:id(\\d+)/authorize', ctrl.authorizeCondition);     // pending_approval → approved (autorizador)
router.post('/:id(\\d+)/cancel-approval', ctrl.cancelApproval);   // pending_approval → draft (editor/autorizador)
router.post('/:id(\\d+)/unlock', ctrl.unlockCondition);           // approved/closed → draft (autorizador)
router.post('/:id(\\d+)/link-to-cv', ctrl.linkSeriesToCv);        // avulsa → CV (promove a série inteira)

// ── Assinatura (DocuSign) da ficha autorizada ─────────────────────────────────
router.get('/:id(\\d+)/signature', ds.getConditionSignature);
router.post('/:id(\\d+)/signature/send', ds.sendConditionSignature);
router.post('/:id(\\d+)/signature/refresh', ds.refreshConditionSignature);
router.post('/:id(\\d+)/signature/void', ds.voidConditionSignature);
router.post('/:id(\\d+)/close', ctrl.closeCondition);             // any → closed (admin, dupla validação)
router.post('/:id(\\d+)/publish', ctrl.publishCondition);         // legado → alias de /submit

// ── Módulos ───────────────────────────────────────────────────────────────────
router.put('/:id(\\d+)/modules', ctrl.upsertModules);
router.delete('/:id(\\d+)/modules/:moduleId(\\d+)', ctrl.deleteModule);
router.post('/:id(\\d+)/modules/:moduleId(\\d+)/copy-from/:sourceId(\\d+)', ctrl.copyModule);
router.post('/:id(\\d+)/modules/:moduleId(\\d+)/copy-from/:sourceConditionId(\\d+)/module/:sourceModuleId(\\d+)', ctrl.copyModuleFromSource);

// ── Campanhas ─────────────────────────────────────────────────────────────────
router.put('/:id(\\d+)/campaigns', ctrl.upsertCampaigns);
router.delete('/:id(\\d+)/campaigns/:campaignId(\\d+)', ctrl.deleteCampaign);

export default router;
