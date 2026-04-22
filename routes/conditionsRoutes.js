// routes/conditionsRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import * as ctrl from '../controllers/comercial/enterpriseConditionController.js';

const router = express.Router();
router.use(authenticate);

// ── Configurações (admin) ─────────────────────────────────────────────────────
router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);

// ── Listagem e criação ────────────────────────────────────────────────────────
router.get('/', ctrl.listConditions);
router.post('/', ctrl.createCondition);             // admin only (guard no controller)

// ── Auxiliares (sem :id numérico — devem vir ANTES das rotas /:id) ────────────
router.get('/correspondents', ctrl.listCorrespondents);
router.get('/correspondents/companies', ctrl.listCorrespondentCompanies);
router.get('/office-users', ctrl.listOfficeUsers);
router.get('/enterprise/:idempreendimento/price-tables', ctrl.getPriceTablesForEnterprise);
router.get('/enterprise/:idempreendimento/price-distribution', ctrl.getPriceDistributionForEnterprise);
router.get('/enterprise/:idempreendimento/modules', ctrl.listModulesForEnterprise);
router.get('/enterprise/:idempreendimento/stages', ctrl.getStagesForEnterprise);
router.get('/enterprise/:idempreendimento/stages/:idetapa/units', ctrl.getUnitsForStage);

// ── CRUD por ficha ────────────────────────────────────────────────────────────
router.get('/:id(\\d+)', ctrl.getCondition);
router.patch('/:id(\\d+)', ctrl.updateCondition);           // admin only, não-approved

// ── Fluxo de aprovação ────────────────────────────────────────────────────────
router.post('/:id(\\d+)/submit', ctrl.submitForApproval);   // draft → pending_approval (admin)
router.post('/:id(\\d+)/unlock', ctrl.unlockCondition);     // approved → draft (admin)
router.post('/:id(\\d+)/publish', ctrl.publishCondition);   // legado → alias de /submit

// ── Módulos ───────────────────────────────────────────────────────────────────
router.put('/:id(\\d+)/modules', ctrl.upsertModules);
router.delete('/:id(\\d+)/modules/:moduleId(\\d+)', ctrl.deleteModule);
router.post('/:id(\\d+)/modules/:moduleId(\\d+)/copy-from/:sourceId(\\d+)', ctrl.copyModule);
router.post('/:id(\\d+)/modules/:moduleId(\\d+)/copy-from/:sourceConditionId(\\d+)/module/:sourceModuleId(\\d+)', ctrl.copyModuleFromSource);

// ── Campanhas ─────────────────────────────────────────────────────────────────
router.put('/:id(\\d+)/campaigns', ctrl.upsertCampaigns);
router.delete('/:id(\\d+)/campaigns/:campaignId(\\d+)', ctrl.deleteCampaign);

export default router;
