// routes/aditivoAssinaturaRoutes.js
//
// API PÚBLICA (sem autenticação) montada em `/api/aditivos` no server.js.
// Quem consome é a LP (lp.menin.com.br/aditivo/<token>), que é o link mandado
// ao cliente. A proteção é o token longo + conferência de CPF no `abrir`.
import express from 'express';
import { consultar, abrir, retorno } from '../controllers/aditivos/assinaturaPublicaController.js';

const router = express.Router();

router.get('/assinatura/:token', consultar);
router.post('/assinatura/:token/abrir', abrir);
router.post('/assinatura/:token/retorno', retorno);

export default router;
