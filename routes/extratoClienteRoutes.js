// routes/extratoClienteRoutes.js
//
// Extrato do cliente (Sienge), montado em `/api/extrato-cliente`. Tudo é
// leitura e cabe na alçada da tela; o recorte por empreendimento é conferido
// DENTRO do serviço, inclusive no título pedido pelo extrato e pelo PDF.
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import P from '../controllers/sienge/extratoClienteController.js';

const TELA = '/comercial/relatorios/extrato-cliente';

const router = express.Router();

router.get('/empreendimentos', authenticate, requireCapability(TELA, 'view'), P.empreendimentos);
router.get('/contratos', authenticate, requireCapability(TELA, 'view'), P.contratos);
router.get('/:titulo/pdf', authenticate, requireCapability(TELA, 'view'), P.pdf);
router.get('/:titulo', authenticate, requireCapability(TELA, 'view'), P.extrato);

export default router;
