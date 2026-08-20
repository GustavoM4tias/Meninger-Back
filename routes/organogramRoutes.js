// routes/organogramRoutes.js
import express from 'express';
import authMiddleware from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import {
    listOverrides,
    upsertOverride,
    deleteOverride,
} from '../controllers/organogramController.js';

const router = express.Router();

// Ações da tela (lib/screenCapabilities.js, a mesma tabela que a tela lê):
//   view → alçada de /settings/organograma (hoje só o Comercial; era aberta a
//          qualquer autenticado até 2026-08-19)
//   edit → admin: reposicionar pessoa grava override de layout
const ORGANOGRAMA = '/settings/organograma';

router.get('/overrides', authMiddleware, requireCapability(ORGANOGRAMA, 'view'), listOverrides);

router.put('/overrides/:userId', authMiddleware, requireCapability(ORGANOGRAMA, 'edit'), upsertOverride);
router.delete('/overrides/:userId', authMiddleware, requireCapability(ORGANOGRAMA, 'edit'), deleteOverride);

export default router;
