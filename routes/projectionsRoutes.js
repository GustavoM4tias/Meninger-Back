import express from 'express';
import * as ctrl from '../controllers/projectionController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(authenticate);

// rotas específicas SEM :id primeiro
router.get('/', ctrl.listProjections);                 // ?year=YYYY
router.post('/', ctrl.createProjection);               // admin
router.post('/clone', ctrl.cloneProjection);  
router.get('/enterprise-picker', ctrl.listEnterprisesForPicker); // <-- AGORA ANTES

// rotas que usam :id com regex numérica
router.get('/:id(\\d+)', ctrl.getProjectionDetail);          // filtra por cidade se não-admin
router.put('/:id(\\d+)/lines', ctrl.upsertProjectionLines);  // admin (bulk)
router.patch('/:id(\\d+)', ctrl.updateProjectionMeta);       // admin (name, lock/unlock)
router.put('/:id(\\d+)/defaults', ctrl.upsertProjectionDefaults); // novo
router.get('/:id(\\d+)/logs', ctrl.getProjectionLogs);       // timeline

export default router;
