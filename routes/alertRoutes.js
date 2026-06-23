// routes/alertRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import {
    list, getOne, create, update, remove, fireNow, logs, preview,
    share, incomingShares, respondShare, shareableUsers, adminStats,
} from '../controllers/alertController.js';

const router = express.Router();

router.get('/',           authenticate, list);
router.post('/',          authenticate, create);
router.post('/preview',   authenticate, preview);

// Rotas estáticas ANTES de '/:id' pra não serem capturadas como id.
router.get('/shares/incoming',          authenticate, incomingShares);
router.post('/shares/:shareId/respond', authenticate, respondShare);
router.get('/shareable-users',          authenticate, shareableUsers);
router.get('/admin/stats',              authenticate, adminStats);

router.get('/:id',        authenticate, getOne);
router.put('/:id',        authenticate, update);
router.delete('/:id',     authenticate, remove);
router.post('/:id/fire',  authenticate, fireNow);
router.post('/:id/share', authenticate, share);
router.get('/:id/logs',   authenticate, logs);

export default router;
