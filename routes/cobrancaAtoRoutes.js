// routes/cobrancaAtoRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import { listHistory, getHistoryStats, getHistoryFacets, getReservaTimeline } from '../controllers/cobrancaAto/cobrancaAtoController.js';

const router = express.Router();
const TELA = '/financeiro/cobranca/ato';
const ver = [authenticate, requireCapability(TELA, 'view')];

// Só leitura unificada. As ações (reprocessar, excluir link, baixar boleto)
// continuam nas rotas de cada forma - o que se faz com cada uma é diferente.
router.get('/history', ...ver, listHistory);
router.get('/history-stats', ...ver, getHistoryStats);
router.get('/history-facets', ...ver, getHistoryFacets);
// Timeline por RESERVA, nao por registro: a historia da cobranca do ato
// atravessa tentativas e ate a troca de forma.
router.get('/timeline/:idreserva', ...ver, getReservaTimeline);

export default router;
