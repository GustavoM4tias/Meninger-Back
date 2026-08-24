// api/routes/platformRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import { getUpdatesState, markUpdatesSeen } from '../controllers/platformController.js';

const router = express.Router();

// requireInternal, igual ao Mural de Avisos: o que muda no Office é assunto de
// dentro de casa. Corretor, imobiliária e correspondente entram pelo mesmo
// login e não têm o que fazer com "o Faturamento passou a...".
router.get('/updates/state', authenticate, requireInternal, getUpdatesState);
router.post('/updates/seen', authenticate, requireInternal, markUpdatesSeen);

export default router;
