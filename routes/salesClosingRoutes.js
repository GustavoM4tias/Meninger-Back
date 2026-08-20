// routes/salesClosingRoutes.js
//
// Fechamento (consolidação) mensal de vendas — vive DENTRO do Faturamento
// (modal admin na tela /comercial/faturamento), por isso a leitura usa a
// alçada dessa tela. Mutações (consolidar, revisar, rodar vigilância): admin.
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import * as ctrl from '../controllers/comercial/salesClosingController.js';

const router = express.Router();
router.use(authenticate);

// Ações do relatório de Faturamento (lib/screenCapabilities.js, a mesma tabela
// que a tela lê): view segue a alçada, configure é admin.
const FATURAMENTO = '/comercial/relatorios/faturamento';
const configurar = requireCapability(FATURAMENTO, 'configure');

// Fechamento é operado de dentro do relatório de Faturamento.
router.use(requireCapability(FATURAMENTO, 'view'));

router.get('/', ctrl.list);
router.get('/:period', ctrl.getOne);

router.post('/:period/consolidate', configurar, ctrl.consolidate);
router.post('/check-divergences/run', configurar, ctrl.runCheck);
router.post('/divergences/:id/review', configurar, ctrl.reviewDivergence);

export default router;
