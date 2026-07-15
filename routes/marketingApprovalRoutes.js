// routes/marketingApprovalRoutes.js
// Aprovações de Marketing: tickets do departamento p/ a diretoria.
import express from 'express';
import ctrl from '../controllers/marketing/marketingApprovalController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireAdmin from '../middlewares/requireAdmin.js';

const router = express.Router();
const internal = [authenticate, requireInternal];
const admin = [authenticate, requireInternal, requireAdmin];

// ── Coleções específicas (antes de /:id) ──
router.get('/cost-centers', ...internal, ctrl.listCostCenters);
router.get('/me', ...internal, ctrl.me);
router.get('/types', ...internal, ctrl.listTypes);
router.get('/profiles', ...internal, ctrl.listProfiles);

// ── Administração (settings + perfis + usuários p/ montar perfis) ──
router.get('/users', ...admin, ctrl.listUsers);
router.get('/settings', ...admin, ctrl.getSettings);
router.put('/settings', ...admin, ctrl.updateSettings);
router.post('/profiles', ...admin, ctrl.createProfile);
router.patch('/profiles/:id(\\d+)', ...admin, ctrl.updateProfile);

// ── Tickets ──
router.get('/', ...internal, ctrl.list);
router.post('/', ...internal, ctrl.create);
router.get('/:id(\\d+)', ...internal, ctrl.getOne);
router.get('/:id(\\d+)/pdf', ...internal, ctrl.downloadPdf);
router.post('/:id(\\d+)/decision', ...internal, ctrl.decide);
router.post('/:id(\\d+)/cancel', ...internal, ctrl.cancel);
router.post('/:id(\\d+)/attachments', ...internal, ctrl.addAttachment);
// Documento de autorização assinado fora do sistema → aprova com o anexo como comprovante.
router.post('/:id(\\d+)/signed-document', ...internal, ctrl.registerSignedDocument);
router.delete('/attachments/:id(\\d+)', ...internal, ctrl.removeAttachment);

export default router;
