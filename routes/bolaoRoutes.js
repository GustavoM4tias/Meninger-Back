// routes/bolaoRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
  getOverview, getLive, getRanking, getRecap,
  postResult, postLive, postParticipant, deleteParticipant, postPredictions, clearPredictions, postSeed, postSync,
} from '../controllers/bolao/bolaoController.js';

const router = express.Router();

// Leitura — qualquer usuário autenticado.
router.get('/', authenticate, getOverview);
router.get('/live', authenticate, getLive);
router.get('/ranking', authenticate, getRanking);
router.get('/recap', authenticate, getRecap);

// Operação — admin.
router.post('/matches/:id/result', authenticate, requireAdmin, postResult); // resultado final
router.post('/matches/:id/live', authenticate, requireAdmin, postLive);     // gol/placar manual
router.post('/participants', authenticate, requireAdmin, postParticipant);        // admin adiciona participante (usuário do sistema)
router.delete('/participants/:id', authenticate, requireAdmin, deleteParticipant); // admin remove participante
router.post('/predictions', authenticate, requireAdmin, postPredictions);   // admin preenche/edita palpites
router.post('/predictions/clear', authenticate, requireAdmin, clearPredictions); // admin apaga todos os palpites
router.post('/seed', authenticate, requireAdmin, postSeed);
router.post('/sync', authenticate, requireAdmin, postSync);

export default router;
