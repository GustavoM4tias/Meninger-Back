// routes/alertRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import {
    list, getOne, create, update, remove, fireNow, logs, preview,
} from '../controllers/alertController.js';

const router = express.Router();

router.get('/',           authenticate, list);
router.post('/',          authenticate, create);
router.post('/preview',   authenticate, preview);
router.get('/:id',        authenticate, getOne);
router.put('/:id',        authenticate, update);
router.delete('/:id',     authenticate, remove);
router.post('/:id/fire',  authenticate, fireNow);
router.get('/:id/logs',   authenticate, logs);

export default router;
