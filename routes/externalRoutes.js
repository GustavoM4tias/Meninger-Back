// routes/externalRoutes.js
import express from 'express';
import landDataController from '../controllers/external/landDataController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();
const ctl = new landDataController();

// A sincronização recorrente roda em processo pelo landScheduler; este endpoint
// é apenas gatilho manual (equivalente a /api/admin/land-sync-obstit/run).
router.post('/land/sync', authenticate, requireAdmin, (req, res) => ctl.run(req, res));

export default router;
