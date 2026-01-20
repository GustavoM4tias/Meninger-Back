// routes/projectionsRoutes.js
import express from 'express';
import * as ctrl from '../controllers/projectionController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(authenticate);

// rotas específicas SEM :id primeiro
router.get('/', ctrl.listProjections);
router.post('/', ctrl.createProjection);
router.post('/clone', ctrl.cloneProjection);
router.get('/enterprise-picker', ctrl.listEnterprisesForPicker);

// rotas que usam :id com regex numérica
router.get('/:id(\\d+)', ctrl.getProjectionDetail);
router.put('/:id(\\d+)/lines', ctrl.upsertProjectionLines);
router.patch('/:id(\\d+)', ctrl.updateProjectionMeta);
router.put('/:id(\\d+)/defaults', ctrl.upsertProjectionDefaults);
router.get('/:id(\\d+)/logs', ctrl.getProjectionLogs);

export default router;
