// routes/aditivoPainelRoutes.js
//
// Acompanhamento INTERNO das assinaturas (autenticado), montado em
// `/api/aditivos/painel`. Nada a ver com `/api/aditivos/assinatura/:token`,
// que é a rota pública do cliente.
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import { listar, atualizar } from '../controllers/aditivos/aditivoPainelController.js';

const TELA = '/comercial/aditivos';

const router = express.Router();

router.get('/', authenticate, requireCapability(TELA, 'view'), listar);
// Releitura no DocuSign: é ação, não leitura — sai da alçada de quem só vê.
router.post('/atualizar', authenticate, requireCapability(TELA, 'operate'), atualizar);

export default router;
