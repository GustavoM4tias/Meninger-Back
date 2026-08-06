// src/routes/deptSpendingRoutes.js
//
// Tela "Gastos por Departamento" (reestruturação da Viabilidade de Marketing).
import express from 'express';
import { getEnterpriseSpending, getEnterprisesSpending, getCompanyReport } from '../controllers/deptSpendingController.js';
import {
    getMarketingDepartments,
    putMarketingDepartment,
    getEnterpriseSettings,
    putEnterpriseSettings,
    putStageSettings,
    putEnterpriseRelease,
    regenerateReportInsights,
} from '../controllers/deptSpendingAdminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';

const router = express.Router();

// Alçada da tela Viabilidade (admin bypassa no middleware).
const requireViability = requireRoutePermission(['/marketing/viabilidade']);

// Análise de 1 empreendimento (por ERP/CC).
router.get('/enterprise/:erpId', authenticate, requireViability, getEnterpriseSpending);

// Lista de todos os empreendimentos com projeção no período.
// Diretoria (não-admin) recebe só os liberados; admin recebe tudo (rascunho + liberado).
router.get('/enterprises', authenticate, requireViability, getEnterprisesSpending);

// Relatório Gerencial de Investimento (por EMPREENDIMENTO: enterprise_key = CC;
// id de empresa Sienge ainda aceito p/ links antigos). Não-admin: só configurado+liberado.
router.get('/report/:key', authenticate, requireViability, getCompanyReport);

/* ===== ADMIN — configuração + liberação (admin-only) ===== */
// Departamentos acompanhados (global)
router.get('/admin/marketing-departments', authenticate, requireAdmin, getMarketingDepartments);
router.put('/admin/marketing-departments', authenticate, requireAdmin, putMarketingDepartment);
// Configuração por EMPRESA Sienge (bloqueadas + overrides de depto + deptos da loja)
router.get('/admin/enterprise-settings', authenticate, requireAdmin, getEnterpriseSettings);
router.put('/admin/enterprise-settings/:companyId', authenticate, requireAdmin, putEnterpriseSettings);
// Configuração por EMPREENDIMENTO (status manual)
router.put('/admin/stage-settings/:key', authenticate, requireAdmin, putStageSettings);
// Liberação por EMPREENDIMENTO (rascunho → liberado)
router.put('/admin/release/:key', authenticate, requireAdmin, putEnterpriseRelease);
// Regenerar a "Leitura para decisão" (IA) do relatório
router.post('/admin/report/:key/insights/regenerate', authenticate, requireAdmin, regenerateReportInsights);

export default router;
