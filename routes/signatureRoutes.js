// routes/signatureRoutes.js
import express from 'express';
import { initiate, sign, list, getById, validate } from '../controllers/signatureController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

// ── Público ───────────────────────────────────────────────────────────────────
// Validação externa de documentos assinados (usado em páginas de auditoria)
router.get('/validate/:code', validate);

// ── Autenticado ───────────────────────────────────────────────────────────────
router.use(authenticate);

// Inicia sessão de assinatura (fase 1 do fluxo MFA)
router.post('/initiate', initiate);

// Verifica senha + facial e assina (fase 2 do fluxo MFA)
router.post('/sign', sign);

// Listagem e detalhe
router.get('/', list);
router.get('/:id', getById);

export default router;
