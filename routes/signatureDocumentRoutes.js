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

// Documentos
router.post('/', create);
router.get('/pending-count', pendingCount);   // ANTES de /:id
router.get('/my-items', listSigningItems);
router.get('/', listDocuments);
router.get('/:id', getDocument);
router.delete('/:id', removeDocument);

// Ações de assinante (por signer_id)
router.post('/signers/:id/initiate', initiateSigner);
router.post('/signers/:id/sign',     signDocument);
router.post('/signers/:id/cancel',   cancelSigner);
router.post('/signers/:id/reject',   rejectSignerRequest);

export default router;
