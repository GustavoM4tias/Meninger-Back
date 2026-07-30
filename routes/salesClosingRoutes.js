// routes/salesClosingRoutes.js
//
// Fechamento (consolidação) mensal de vendas.
// Leitura: alçada da tela /comercial/fechamento (admin bypassa).
// Mutações (consolidar, revisar divergência, rodar vigilância): admin only.
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import * as ctrl from '../controllers/comercial/salesClosingController.js';

const router = express.Router();
router.use(authenticate);
router.use(requireRoutePermission(['/comercial/fechamento']));

router.get('/', ctrl.list);
router.get('/:period', ctrl.getOne);

router.post('/:period/consolidate', requireAdmin, ctrl.consolidate);
router.post('/check-divergences/run', requireAdmin, ctrl.runCheck);
router.post('/divergences/:id/review', requireAdmin, ctrl.reviewDivergence);

export default router;
