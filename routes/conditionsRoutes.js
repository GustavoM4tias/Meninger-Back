// routes/conditionsRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import * as ctrl from '../controllers/comercial/enterpriseConditionController.js';

const router = express.Router();
router.use(authenticate);

// Listagem e criação
router.get('/', ctrl.listConditions);
router.post('/', ctrl.createCondition);

// Auxiliares (sem :id numérico)
router.get('/correspondents', ctrl.listCorrespondents);
router.get('/correspondents/companies', ctrl.listCorrespondentCompanies);
router.get('/office-users', ctrl.listOfficeUsers);
router.get('/enterprise/:idempreendimento/price-tables', ctrl.getPriceTablesForEnterprise);
router.get('/enterprise/:idempreendimento/price-distribution', ctrl.getPriceDistributionForEnterprise);

// CRUD por ficha
router.get('/:id(\\d+)', ctrl.getCondition);
router.patch('/:id(\\d+)', ctrl.updateCondition);
router.post('/:id(\\d+)/publish', ctrl.publishCondition);

// Módulos
router.put('/:id(\\d+)/modules', ctrl.upsertModules);
router.post('/:id(\\d+)/modules/:moduleId(\\d+)/copy-from/:sourceId(\\d+)', ctrl.copyModule);

// Campanhas
router.put('/:id(\\d+)/campaigns', ctrl.upsertCampaigns);
router.delete('/:id(\\d+)/campaigns/:campaignId(\\d+)', ctrl.deleteCampaign);

export default router;
