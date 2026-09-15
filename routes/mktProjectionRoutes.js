// routes/mktProjectionRoutes.js
// Projeção de Investimentos de Marketing: os números vêm da planilha do
// SharePoint (services/marketing/mktProjectionService.js).
//
//   view      -> ler os números (quem tem a tela)
//   refresh   -> forçar a releitura do arquivo (quem tem a tela)
//   configure -> trocar a planilha, abas ignoradas e a régua do status (admin)
import express from 'express';
import ctrl from '../controllers/marketing/mktProjectionController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireCapability from '../middlewares/requireCapability.js';

const router = express.Router();

const ROUTE = '/marketing/projecao-investimentos';
const canView = [authenticate, requireInternal, requireCapability(ROUTE, 'view')];
const canRefresh = [authenticate, requireInternal, requireCapability(ROUTE, 'refresh')];
const canConfigure = [authenticate, requireInternal, requireCapability(ROUTE, 'configure')];

router.get('/data', ...canView, ctrl.getData);
router.post('/refresh', ...canRefresh, ctrl.refresh);
// Ler a configuração faz parte de entender de onde vem o número (a tela mostra
// o nome do arquivo e a régua); mudar é admin.
router.get('/settings', ...canView, ctrl.getSettings);
router.patch('/settings', ...canConfigure, ctrl.updateSettings);

export default router;
