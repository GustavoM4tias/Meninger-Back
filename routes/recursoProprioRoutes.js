// routes/recursoProprioRoutes.js
//
// Relatório de Recurso Próprio por cliente, montado em `/api/recurso-proprio`.
// Ler é alçada da tela; anotar a reserva também (é trabalho de quem acompanha
// a carteira); mudar como as séries são lidas vale para todos os leitores, então
// é admin. O empreendimento é conferido contra o escopo DENTRO do serviço.
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import P from '../controllers/comercial/recursoProprioController.js';

const TELA = '/comercial/relatorios/recurso-proprio';

const router = express.Router();

router.get('/empreendimentos', authenticate, requireCapability(TELA, 'view'), P.empreendimentos);
router.get('/', authenticate, requireCapability(TELA, 'view'), P.relatorio);
router.get('/config', authenticate, requireCapability(TELA, 'view'), P.config);
router.put('/config', authenticate, requireCapability(TELA, 'configure'), P.salvarConfig);
router.put('/notas/:idreserva', authenticate, requireCapability(TELA, 'annotate'), P.salvarNota);

export default router;
