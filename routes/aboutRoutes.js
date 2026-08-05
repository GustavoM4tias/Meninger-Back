// routes/aboutRoutes.js
// "Sobre o Office" — apresentação do sistema para a diretoria.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import { getMetrics } from '../controllers/about/aboutController.js';

const router = express.Router();

// Somente admin: os números incluem economia e custo de ferramenta da companhia.
router.get('/metrics', authenticate, requireAdmin, getMetrics);

export default router;
