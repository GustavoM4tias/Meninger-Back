// routes/projectionsRoutes.js
import express from 'express';
import * as ctrl from '../controllers/projectionController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import requireCapability from '../middlewares/requireCapability.js';
import { RELATORIO_SCREENS } from '../lib/relatorioScreens.js';

const router = express.Router();

router.use(authenticate);

// Telas que LEEM projeção (dashboards) × tela que EDITA (editor).
const READ_SCREENS = ['/comercial/projections', ...RELATORIO_SCREENS];
const EDIT_SCREEN = ['/comercial/projections'];
// Acao `edit` do Editor de Projecao (lib/screenCapabilities.js). O guard ja
// existia como assertAdmin dentro do controller; aqui fica declarado na rota.
// listEnterprisesForPicker e getProjectionLogs NAO tinham assertAdmin, entao
// seguem no gate de tela para nao tirar acesso de ninguem.
const editarProjecao = requireCapability('/comercial/projections', 'edit');
// Ação `configure` do relatório Vendas x Projeção (lib/screenCapabilities.js).
const configurarProjecao = requireCapability('/comercial/relatorios/projecao', 'configure');

// rotas específicas SEM :id primeiro
router.get('/', requireRoutePermission(READ_SCREENS), ctrl.listProjections);
router.post('/', editarProjecao, ctrl.createProjection);
router.post('/clone', editarProjecao, ctrl.cloneProjection);
router.get('/enterprise-picker', requireRoutePermission(EDIT_SCREEN), ctrl.listEnterprisesForPicker);
router.get('/report', requireRoutePermission(READ_SCREENS), ctrl.getProjectionReport);
// nomes de exibição por CC (fonte única = projeção ativa, com fallback override).
// Consumido também por Custos/Títulos para rotular centros de custo.
router.get('/cost-center-names', requireRoutePermission([...READ_SCREENS, '/financeiro/custos', '/financeiro/titulos']), ctrl.getActiveProjectionCostCenterNames);

// Modo de meta (unidades × VGV): regra GLOBAL. Quem tem a tela lê; só admin
// grava (assertAdmin dentro do controller).
// Ler o modo de meta é de quem tem a tela (o não-admin vê a regra vigente);
// GRAVAR é admin — a regra vale para todos os leitores. O guard já existia
// dentro do controller (assertAdmin); agora está DECLARADO na rota, então o
// validador de integridade enxerga e a tela lê a mesma regra pelo can().
router.get('/goal-mode', requireRoutePermission(READ_SCREENS), ctrl.getGoalMode);
router.put('/goal-mode', configurarProjecao, ctrl.setGoalMode);

// rotas que usam :id com regex numérica
router.get('/:id(\\d+)', requireRoutePermission(READ_SCREENS), ctrl.getProjectionDetail);
router.put('/:id(\\d+)/grid', editarProjecao, ctrl.upsertProjectionGrid);   // salvamento unificado (tela nova)
router.put('/:id(\\d+)/lines', editarProjecao, ctrl.upsertProjectionLines); // legado (mantido p/ compat)
router.patch('/:id(\\d+)', editarProjecao, ctrl.updateProjectionMeta);
router.put('/:id(\\d+)/defaults', editarProjecao, ctrl.upsertProjectionDefaults); // legado
router.delete('/:id(\\d+)', editarProjecao, ctrl.deleteProjection);
router.get('/:id(\\d+)/logs', requireRoutePermission(EDIT_SCREEN), ctrl.getProjectionLogs);

export default router;
