// routes/salesStandRoutes.js
// Stand de Vendas: stands modelo (categorias) + stands reais com custo ao vivo
// do Sienge (plano financeiro 20207 — Despesas com Stand).
import express from 'express';
import ctrl from '../controllers/marketing/salesStandController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';

const router = express.Router();
// Alçada da tela Stand de Vendas (admin bypassa no middleware).
const internal = [authenticate, requireInternal, requireRoutePermission(['/marketing/stand-vendas'])];

// ── Coleções específicas (antes de /:id) ──
router.get('/cost-centers', ...internal, ctrl.listCostCenters);

// ── Stands modelo (categorias) ──
router.get('/models', ...internal, ctrl.listModels);
router.post('/models', ...internal, ctrl.createModel);
router.patch('/models/:id(\\d+)', ...internal, ctrl.updateModel);
router.delete('/models/:id(\\d+)', ...internal, ctrl.deleteModel);

// ── Stands reais ──
router.get('/', ...internal, ctrl.listStands);
router.post('/', ...internal, ctrl.createStand);
router.get('/:id(\\d+)/spend', ...internal, ctrl.getStandSpend);
router.patch('/:id(\\d+)', ...internal, ctrl.updateStand);
router.delete('/:id(\\d+)', ...internal, ctrl.deleteStand);
router.post('/:id(\\d+)/define', ...internal, ctrl.defineStand);
router.post('/:id(\\d+)/undefine', ...internal, ctrl.undefineStand);

export default router;
