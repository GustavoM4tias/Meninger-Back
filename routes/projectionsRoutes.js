// routes/projectionsRoutes.js
import express from 'express';
import * as ctrl from '../controllers/projectionController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import { RELATORIO_SCREENS } from '../lib/relatorioScreens.js';

const router = express.Router();

router.use(authenticate);

// Telas que LEEM projeção (dashboards) × tela que EDITA (editor).
const READ_SCREENS = ['/comercial/projections', ...RELATORIO_SCREENS];
const EDIT_SCREEN = ['/comercial/projections'];

// rotas específicas SEM :id primeiro
router.get('/', requireRoutePermission(READ_SCREENS), ctrl.listProjections);
router.post('/', requireRoutePermission(EDIT_SCREEN), ctrl.createProjection);
router.post('/clone', requireRoutePermission(EDIT_SCREEN), ctrl.cloneProjection);
router.get('/enterprise-picker', requireRoutePermission(EDIT_SCREEN), ctrl.listEnterprisesForPicker);
router.get('/report', requireRoutePermission(READ_SCREENS), ctrl.getProjectionReport);
// nomes de exibição por CC (fonte única = projeção ativa, com fallback override).
// Consumido também por Custos/Títulos para rotular centros de custo.
router.get('/cost-center-names', requireRoutePermission([...READ_SCREENS, '/financeiro/custos', '/financeiro/titulos']), ctrl.getActiveProjectionCostCenterNames);

// Modo de meta (unidades × VGV): regra GLOBAL. Quem tem a tela lê; só admin
// grava (assertAdmin dentro do controller).
router.get('/goal-mode', requireRoutePermission(READ_SCREENS), ctrl.getGoalMode);
router.put('/goal-mode', requireRoutePermission(READ_SCREENS), ctrl.setGoalMode);

// rotas que usam :id com regex numérica
router.get('/:id(\\d+)', requireRoutePermission(READ_SCREENS), ctrl.getProjectionDetail);
router.put('/:id(\\d+)/grid', requireRoutePermission(EDIT_SCREEN), ctrl.upsertProjectionGrid);   // salvamento unificado (tela nova)
router.put('/:id(\\d+)/lines', requireRoutePermission(EDIT_SCREEN), ctrl.upsertProjectionLines); // legado (mantido p/ compat)
router.patch('/:id(\\d+)', requireRoutePermission(EDIT_SCREEN), ctrl.updateProjectionMeta);
router.put('/:id(\\d+)/defaults', requireRoutePermission(EDIT_SCREEN), ctrl.upsertProjectionDefaults); // legado
router.delete('/:id(\\d+)', requireRoutePermission(EDIT_SCREEN), ctrl.deleteProjection);
router.get('/:id(\\d+)/logs', requireRoutePermission(EDIT_SCREEN), ctrl.getProjectionLogs);

export default router;
