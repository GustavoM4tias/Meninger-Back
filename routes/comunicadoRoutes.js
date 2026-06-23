// routes/comunicadoRoutes.js
// Mural de Avisos / Comunicados — módulo próprio do Office (fora do Academy).
import express from 'express';
import comunicadoController from '../controllers/comunicadoController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();

// ───────────── Usuário (mural interno do Office) ─────────────
// Rotas literais antes das paramétricas; ack exige id numérico para não casar /me.
router.get('/me', authenticate, requireInternal, comunicadoController.myList);
router.get('/me/pending', authenticate, requireInternal, comunicadoController.myPending);
router.post('/:id(\\d+)/ack', authenticate, requireInternal, comunicadoController.ack);

// ───────────── Admin (interno + admin) ─────────────
router.get('/admin', authenticate, requireInternal, requireAdmin, comunicadoController.adminList);
router.post('/admin', authenticate, requireInternal, requireAdmin, comunicadoController.adminCreate);
router.get('/admin/:id(\\d+)', authenticate, requireInternal, requireAdmin, comunicadoController.adminGet);
router.patch('/admin/:id(\\d+)', authenticate, requireInternal, requireAdmin, comunicadoController.adminUpdate);
router.delete('/admin/:id(\\d+)', authenticate, requireInternal, requireAdmin, comunicadoController.adminRemove);
router.put('/admin/:id(\\d+)/assignments', authenticate, requireInternal, requireAdmin, comunicadoController.adminSetAssignments);
router.post('/admin/:id(\\d+)/publish', authenticate, requireInternal, requireAdmin, comunicadoController.adminPublish);
router.post('/admin/:id(\\d+)/refresh', authenticate, requireInternal, requireAdmin, comunicadoController.adminRefresh);
router.patch('/admin/:id(\\d+)/status', authenticate, requireInternal, requireAdmin, comunicadoController.adminSetStatus);
router.get('/admin/:id(\\d+)/adherence', authenticate, requireInternal, requireAdmin, comunicadoController.adminAdherence);

export default router;
