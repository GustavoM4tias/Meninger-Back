// routes/shortLinkRoutes.js
//
// Rota pública (sem autenticação) montada em `/s` no server.js.
// Apenas redirect — qualquer admin/listagem deve viver em /api/short-links
// se um dia for necessário.
import express from 'express';
import { publicRedirect } from '../controllers/shortLink/shortLinkController.js';

const router = express.Router();

router.get('/:slug', publicRedirect);

export default router;
