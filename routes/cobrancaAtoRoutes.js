// routes/cobrancaAtoRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import { listHistory, getHistoryStats, getHistoryFacets, getReservaTimeline } from '../controllers/cobrancaAto/cobrancaAtoController.js';
import P from '../controllers/cobrancaAto/atoParcelasController.js';

const router = express.Router();
const TELA = '/financeiro/cobranca/ato';
const ver = [authenticate, requireCapability(TELA, 'view')];
const operar = [authenticate, requireCapability(TELA, 'operate')];
const configurar = [authenticate, requireCapability(TELA, 'configure')];

// Só leitura unificada. As ações (reprocessar, excluir link, baixar boleto)
// continuam nas rotas de cada forma - o que se faz com cada uma é diferente.
router.get('/history', ...ver, listHistory);
router.get('/history-stats', ...ver, getHistoryStats);
router.get('/history-facets', ...ver, getHistoryFacets);
// Timeline por RESERVA, nao por registro: a historia da cobranca do ato
// atravessa tentativas e ate a troca de forma.
router.get('/timeline/:idreserva', ...ver, getReservaTimeline);

// ── Parcelas mensais (plano por reserva) ─────────────────────────────────────
// view: lista, KPIs, detalhe. operate: criar/sincronizar/pausar/encerrar plano,
// emitir/baixar/marcar parcela. configure: rodar o ciclo e templates WhatsApp.
router.get('/parcelas/planos', ...ver, P.listPlanos);
router.get('/parcelas/stats', ...ver, P.getStats);
router.get('/parcelas/facets', ...ver, P.getFacets);
router.get('/parcelas/status', ...ver, P.getStatus);
router.get('/parcelas/planos/:idreserva', ...ver, P.getPlano);
router.post('/parcelas/planos', ...operar, P.criarPlano);
router.post('/parcelas/planos/:idreserva/sincronizar', ...operar, P.sincronizarPlano);
router.post('/parcelas/planos/:idreserva/pausar', ...operar, P.pausarPlano);
router.post('/parcelas/planos/:idreserva/reativar', ...operar, P.reativarPlano);
router.post('/parcelas/planos/:idreserva/encerrar', ...operar, P.encerrarPlano);
router.post('/parcelas/:id/emitir', ...operar, P.emitirParcela);
router.post('/parcelas/:id/baixar', ...operar, P.baixarParcela);
router.post('/parcelas/:id/marcar-paga', ...operar, P.marcarPaga);
router.post('/parcelas/rodar', ...configurar, P.rodarCiclo);
router.get('/parcelas/whatsapp-templates', ...configurar, P.getWhatsappTemplates);
router.post('/parcelas/whatsapp-templates/sync', ...configurar, P.syncWhatsappTemplates);

export default router;
