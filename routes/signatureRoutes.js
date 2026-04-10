import express from 'express';
import {
  initiate,
  initiateRequest,
  sign,
  request,
  cancel,
  reject,
  deleteRecord,
  list,
  sent,
  pending,
  pendingCount,
  getById,
  validate,
} from '../controllers/signatureController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

// Público
router.get('/validate/:code', validate);

// Autenticado
router.use(authenticate);

router.post('/initiate', initiate);
router.post('/initiate-request/:id', initiateRequest);
router.post('/sign', sign);

router.post('/request', request);

router.post('/:id/cancel', cancel);
router.post('/:id/reject', reject);
router.delete('/:id', deleteRecord);

router.get('/pending-count', pendingCount);
router.get('/pending', pending);
router.get('/sent', sent);
router.get('/', list);
router.get('/:id', getById);

export default router;