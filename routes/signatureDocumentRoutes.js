// routes/signatureDocumentRoutes.js
import express from 'express';
import {
  create,
  listDocuments,
  listSigningItems,
  pendingCount,
  getDocument,
  removeDocument,
  initiateSigner,
  signDocument,
  cancelSigner,
  rejectSignerRequest,
  validateDocument,
} from '../controllers/signatureDocumentController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

// ── Público ───────────────────────────────────────────────────────────────────
router.get('/validate/:code', validateDocument);

// ── Autenticado ───────────────────────────────────────────────────────────────
router.use(authenticate);

// Rotas sem parâmetro dinâmico — devem vir ANTES de /:id
router.post('/', create);
router.get('/pending-count', pendingCount);
router.get('/my-items', listSigningItems);
router.get('/', listDocuments);

// Ações de assinante — /signers/:id/* deve vir ANTES de /:id
// para que Express não capture "signers" como um :id de documento
router.post('/signers/:id(\\d+)/initiate', initiateSigner);
router.post('/signers/:id(\\d+)/sign',     signDocument);
router.post('/signers/:id(\\d+)/cancel',   cancelSigner);
router.post('/signers/:id(\\d+)/reject',   rejectSignerRequest);

// Rotas de documento por ID — depois de /signers/* para não capturar antes
router.get('/:id(\\d+)', getDocument);
router.delete('/:id(\\d+)', removeDocument);

export default router;
