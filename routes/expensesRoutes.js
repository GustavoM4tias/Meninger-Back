// routes/expenses.js
import { Router } from 'express';
import expenseController from '../controllers/expenseController.js';
import {
    listCostCenterOverrides,
    getCostCenterOverrideMap,
    setCostCenterOverride,
    deleteCostCenterOverride,
    listDepartmentVisibility,
    setDepartmentVisibility,
} from '../controllers/expensesAdminController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';

const router = Router();
const ctrl = new expenseController();

router.use(authenticate);

// ── Custos (leitura ao vivo do backup) + personalização (observação) ──────
router.get('', requireRoutePermission(['/financeiro/custos']), ctrl.listMonth);
router.put('/:id', requireRoutePermission(['/financeiro/custos']), ctrl.update);     // edita observação (id = "<nutitulo>-<nuparcela>")
router.delete('/:id', requireRoutePermission(['/financeiro/custos']), ctrl.remove);  // limpa personalização da parcela

// ── Mapa de overrides de nome de CC (consumido por Custos e Títulos) ──────
router.get('/cost-center-overrides/map', requireRoutePermission(['/financeiro/custos', '/financeiro/titulos']), getCostCenterOverrideMap);

// ── Admin: gestão de overrides de nome de empreendimento por CC ──────────
router.get('/admin/cost-center-overrides', listCostCenterOverrides);
router.put('/admin/cost-center-overrides/:ccId', setCostCenterOverride);
router.delete('/admin/cost-center-overrides/:ccId', deleteCostCenterOverride);

// ── Admin: visibilidade de departamentos no filtro ────────────────────────
router.get('/admin/department-visibility', listDepartmentVisibility);
router.put('/admin/department-visibility', setDepartmentVisibility);

export default router;
