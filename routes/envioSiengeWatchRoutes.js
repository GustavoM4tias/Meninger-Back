// routes/envioSiengeWatchRoutes.js
//
// Vigia do envio da venda ao ERP. Tela de administração do próprio sistema:
// admin-only nos três níveis (aqui, no meta da rota e no navRegistry).
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import {
    getSettings, updateSettings, listPendencias, runNow, encerrarItem,
} from '../controllers/sienge/envioSiengeWatchController.js';

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.get('/pendencias', listPendencias);
router.post('/run', runNow);
router.post('/itens/:id/encerrar', encerrarItem);

export default router;
