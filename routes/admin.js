// routes/admin.js
import express from 'express';
import db from '../models/sequelize/index.js';
import authMiddleware from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

import {
  listPositions,
  createPosition,
  updatePosition,
  deletePosition,
} from '../controllers/positionController.js';

import { listUserCities } from '../controllers/userCityController.js';

import {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from '../controllers/departmentController.js';

import {
  listLandSyncEnterprises,
  addLandSyncEnterprise,
  removeLandSyncEnterprise
} from '../controllers/landSyncController.js';

import {
  listHiddenEnterprises,
  addHiddenEnterprise,
  removeHiddenEnterprise
} from '../controllers/hiddenDashboardController.js';

import {
  listStageCommissionRules,
  addStageCommissionRule,
  removeStageCommissionRule
} from '../controllers/stageCommissionRuleController.js';

import {
  listEnterpriseValueRules,
  addEnterpriseValueRule,
  removeEnterpriseValueRule
} from '../controllers/enterpriseValueRuleController.js';

import {
  listErpLinks,
  addErpLink,
  removeErpLink,
  listUnlinkedProjections
} from '../controllers/enterpriseErpLinkController.js';

import {
  listTrSatellites,
  addTrSatellite,
  updateTrSatellite,
  removeTrSatellite
} from '../controllers/trSatelliteController.js';

import LandDataController from '../controllers/external/landDataController.js';
import {
  listEnterprises as orgListEnterprises,
  listCompanies as orgListCompanies,
  syncCrm as orgSyncCrm,
  syncErp as orgSyncErp,
  consolidate as orgConsolidate,
  pair as orgPair,
  updateEnterprise as orgUpdateEnterprise,
} from '../controllers/orgRegistryController.js';
import { runIntegrityCheck } from '../security/integrityCheck.js';
const landDataController = new LandDataController();


const router = express.Router();

router.post('/admin/drop-legacy-sienge', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const sql = ` 
      DROP VIEW  IF EXISTS sales_contracts_v; 
      DROP TABLE IF EXISTS sales_contracts; 
    `;
    await db.sequelize.query(sql);
    return res.json({ ok: true, message: 'Tabelas/Views antigas removidas.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// enterprise-cities foi APOSENTADA (2026-07-29): substituída pelo registro
// unificado (/admin/org/*) e pelos rótulos escopados em /api/org.

// Validador de integridade de segurança (tela /settings/integrity)
router.post('/integrity-check', authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const report = await runIntegrityCheck();
    return res.json(report);
  } catch (e) {
    console.error('[integrity-check]', e);
    return res.status(500).json({ error: e.message });
  }
});

// Registro unificado de empresas/empreendimentos (tela Sincronização de
// empresas — substitui os Vínculos de cidades). APENAS ADMIN.
router.get('/org/enterprises', authMiddleware, requireAdmin, orgListEnterprises);
router.get('/org/companies', authMiddleware, requireAdmin, orgListCompanies);
router.post('/org/sync/crm', authMiddleware, requireAdmin, orgSyncCrm);
router.post('/org/sync/erp', authMiddleware, requireAdmin, orgSyncErp);
router.post('/org/consolidate', authMiddleware, requireAdmin, orgConsolidate);
router.post('/org/enterprises/:id/pair', authMiddleware, requireAdmin, orgPair);
router.put('/org/enterprises/:id', authMiddleware, requireAdmin, orgUpdateEnterprise);

// Positions (cargos) – APENAS ADMIN
router.get('/positions', authMiddleware, requireAdmin, listPositions);
router.post('/positions', authMiddleware, requireAdmin, createPosition);
router.put('/positions/:id', authMiddleware, requireAdmin, updatePosition);
router.delete('/positions/:id', authMiddleware, requireAdmin, deletePosition);

// UserCities (cidades) — SOMENTE LEITURA (2026-07-29): o cadastro manual foi
// aposentado; o catálogo é alimentado automaticamente pelas cidades dos
// empreendimentos sincronizados (enterpriseRegistryService.syncUserCitiesFromRegistry).
router.get('/user-cities', authMiddleware, requireAdmin, listUserCities);

// Departments – APENAS ADMIN
router.get('/departments', authMiddleware, requireAdmin, listDepartments);
router.post('/departments', authMiddleware, requireAdmin, createDepartment);
router.put('/departments/:id', authMiddleware, requireAdmin, updateDepartment);
router.delete('/departments/:id', authMiddleware, requireAdmin, deleteDepartment);

router.get('/land-sync-enterprises', authMiddleware, requireAdmin, listLandSyncEnterprises);
router.post('/land-sync-enterprises', authMiddleware, requireAdmin, addLandSyncEnterprise);
router.delete('/land-sync-enterprises/:id', authMiddleware, requireAdmin, removeLandSyncEnterprise);
 
router.post( '/land-sync-obstit/run', authMiddleware, requireAdmin, landDataController.run );

// Hidden Dashboard Enterprises — GET: todos autenticados; mutações: admin only.
// O admin configura, mas a ocultação vale para TODOS os usuários do dashboard;
// por isso a leitura precisa estar liberada (antes o não-admin recebia 403 e
// acabava enxergando justamente os empreendimentos que deveriam sumir).
router.get('/hidden-enterprises', authMiddleware, listHiddenEnterprises);
router.post('/hidden-enterprises', authMiddleware, requireAdmin, addHiddenEnterprise);
router.delete('/hidden-enterprises/:id', authMiddleware, requireAdmin, removeHiddenEnterprise);

// Stage Commission Rules — GET: todos autenticados; POST/DELETE: admin only
router.get('/stage-commission-rules', authMiddleware, listStageCommissionRules);
router.post('/stage-commission-rules', authMiddleware, requireAdmin, addStageCommissionRule);
router.delete('/stage-commission-rules/:id', authMiddleware, requireAdmin, removeStageCommissionRule);

// Enterprise Value Rules (composição de VGV) — GET: todos autenticados; mutações: admin only
router.get('/enterprise-value-rules', authMiddleware, listEnterpriseValueRules);
router.post('/enterprise-value-rules', authMiddleware, requireAdmin, addEnterpriseValueRule);
router.delete('/enterprise-value-rules/:id', authMiddleware, requireAdmin, removeEnterpriseValueRule);

// Vínculo CV ↔ Sienge das projeções — GET: todos autenticados; mutações: admin only
router.get('/enterprise-erp-links/pendentes', authMiddleware, listUnlinkedProjections);
router.get('/enterprise-erp-links', authMiddleware, listErpLinks);
router.post('/enterprise-erp-links', authMiddleware, requireAdmin, addErpLink);
router.delete('/enterprise-erp-links/:id', authMiddleware, requireAdmin, removeErpLink);

// TR Satellite Enterprises — GET: todos autenticados; mutações: admin only
router.get('/tr-satellite-enterprises', authMiddleware, listTrSatellites);
router.post('/tr-satellite-enterprises', authMiddleware, requireAdmin, addTrSatellite);
router.put('/tr-satellite-enterprises/:id', authMiddleware, requireAdmin, updateTrSatellite);
router.delete('/tr-satellite-enterprises/:id', authMiddleware, requireAdmin, removeTrSatellite);

export default router;
