// routes/organogramRoutes.js
import express from 'express';
import authMiddleware from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
    listOverrides,
    upsertOverride,
    deleteOverride,
} from '../controllers/organogramController.js';

const router = express.Router();

// Leitura: qualquer autenticado (o organograma é visível a todos).
router.get('/overrides', authMiddleware, listOverrides);

// Escrita: apenas admin.
router.put('/overrides/:userId', authMiddleware, requireAdmin, upsertOverride);
router.delete('/overrides/:userId', authMiddleware, requireAdmin, deleteOverride);

export default router;
