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

const router = Router();
const ctrl = new expenseController();

router.use(authenticate);

// ── CRUD básico (já existia) ─────────────────────────────────────────────
router.post('', authenticate, ctrl.add);
router.get('', ctrl.listMonth);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
router.get('/links', ctrl.listLinks);

// ── Leitura do mapa de overrides (qualquer usuário autenticado) ──────────
router.get('/cost-center-overrides/map', getCostCenterOverrideMap);

// ── Admin: gestão de overrides de nome de empreendimento por CC ──────────
router.get('/admin/cost-center-overrides', listCostCenterOverrides);
router.put('/admin/cost-center-overrides/:ccId', setCostCenterOverride);
router.delete('/admin/cost-center-overrides/:ccId', deleteCostCenterOverride);

// ── Admin: visibilidade de departamentos no filtro ────────────────────────
router.get('/admin/department-visibility', listDepartmentVisibility);
router.put('/admin/department-visibility', setDepartmentVisibility);

export default router;
