// routes/comunicadoRoutes.js
// Mural de Avisos / Comunicados — módulo próprio do Office (fora do Academy).
import express from 'express';
import comunicadoController from '../controllers/comunicadoController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireCapability from '../middlewares/requireCapability.js';

const router = express.Router();

// Gestão do Mural: delegável por alçada desde 2026-08-20. Uma linha por AÇÃO,
// com a regra em lib/screenCapabilities.js (a mesma que a tela consulta):
//   view/manage → alçada da tela | remove → admin (excluir some com a trilha
//   de leitura do comunicado, então não se delega).
const MURAL_SCREEN = '/mural/admin';
const ver = [authenticate, requireInternal, requireCapability(MURAL_SCREEN, 'view')];
const gerir = [authenticate, requireInternal, requireCapability(MURAL_SCREEN, 'manage')];
const excluir = [authenticate, requireInternal, requireCapability(MURAL_SCREEN, 'remove')];

// ───────────── Usuário (mural interno do Office) ─────────────
// Rotas literais antes das paramétricas; ack exige id numérico para não casar /me.
router.get('/me', authenticate, requireInternal, comunicadoController.myList);
router.get('/me/pending', authenticate, requireInternal, comunicadoController.myPending);
router.post('/:id(\\d+)/ack', authenticate, requireInternal, comunicadoController.ack);

// ───────────── Gestão do Mural (/mural/admin) ─────────────
router.get('/admin', ...ver, comunicadoController.adminList);
router.post('/admin', ...gerir, comunicadoController.adminCreate);
router.get('/admin/:id(\\d+)', ...ver, comunicadoController.adminGet);
router.patch('/admin/:id(\\d+)', ...gerir, comunicadoController.adminUpdate);
router.delete('/admin/:id(\\d+)', ...excluir, comunicadoController.adminRemove);
router.put('/admin/:id(\\d+)/assignments', ...gerir, comunicadoController.adminSetAssignments);
router.post('/admin/:id(\\d+)/publish', ...gerir, comunicadoController.adminPublish);
router.post('/admin/:id(\\d+)/refresh', ...gerir, comunicadoController.adminRefresh);
router.patch('/admin/:id(\\d+)/status', ...gerir, comunicadoController.adminSetStatus);
router.get('/admin/:id(\\d+)/adherence', ...ver, comunicadoController.adminAdherence);

export default router;
