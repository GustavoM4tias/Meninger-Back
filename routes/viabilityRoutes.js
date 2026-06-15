// src/routes/viabilityRoutes.js
import express from 'express';
import { getEnterpriseViability, getEnterprisesViability } from '../controllers/viabilityController.js';
import {
    getMarketingDepartments,
    putMarketingDepartment,
    getEnterpriseSettings,
    putEnterpriseSettings,
} from '../controllers/viabilityAdminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();

// Ex.: GET /api/viability/enterprise/80001?year=2025&aliasId=default&cvEnterpriseId=123&costCenterId=80001
router.get('/enterprise/:erpId', authenticate, getEnterpriseViability);

// ✅ NOVO: viabilidade de TODOS os empreendimentos com projeção no ano/alias
// Ex.: GET /api/viability/enterprises?year=2025&aliasId=default
router.get('/enterprises', authenticate, getEnterprisesViability);

/* ===== ADMIN — configuração (admin-only) ===== */
// Departamentos que contam como marketing (global)
router.get('/admin/marketing-departments', authenticate, requireAdmin, getMarketingDepartments);
router.put('/admin/marketing-departments', authenticate, requireAdmin, putMarketingDepartment);
// Configuração por empreendimento (bloqueadas consideradas disponíveis + overrides de depto)
router.get('/admin/enterprise-settings', authenticate, requireAdmin, getEnterpriseSettings);
router.put('/admin/enterprise-settings/:enterpriseKey', authenticate, requireAdmin, putEnterpriseSettings);

export default router;
