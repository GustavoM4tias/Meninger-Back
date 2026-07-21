// src/routes/deptSpendingRoutes.js
//
// Tela "Gastos por Departamento" (reestruturação da Viabilidade de Marketing).
import express from 'express';
import { getEnterpriseSpending, getEnterprisesSpending } from '../controllers/deptSpendingController.js';
import {
    getMarketingDepartments,
    putMarketingDepartment,
    getEnterpriseSettings,
    putEnterpriseSettings,
    putEnterpriseRelease,
} from '../controllers/deptSpendingAdminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();

// Análise de 1 empreendimento (por ERP/CC).
router.get('/enterprise/:erpId', authenticate, getEnterpriseSpending);

// Lista de todos os empreendimentos com projeção no período.
// Diretoria (não-admin) recebe só os liberados; admin recebe tudo (rascunho + liberado).
router.get('/enterprises', authenticate, getEnterprisesSpending);

/* ===== ADMIN — configuração + liberação (admin-only) ===== */
// Departamentos acompanhados (global)
router.get('/admin/marketing-departments', authenticate, requireAdmin, getMarketingDepartments);
router.put('/admin/marketing-departments', authenticate, requireAdmin, putMarketingDepartment);
// Configuração por empreendimento (bloqueadas + overrides de depto + status)
router.get('/admin/enterprise-settings', authenticate, requireAdmin, getEnterpriseSettings);
router.put('/admin/enterprise-settings/:companyId', authenticate, requireAdmin, putEnterpriseSettings);
// Liberação por empreendimento (rascunho → liberado)
router.put('/admin/release/:companyId', authenticate, requireAdmin, putEnterpriseRelease);

export default router;
