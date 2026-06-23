// routes/checklistRoutes.js
// Módulo Checklist (gestão de lançamentos e demandas). Substitui o Planner.
import express from 'express';
import checklistController from '../controllers/checklist/checklistController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import uploadExcelSingle from '../middlewares/excelUploadMiddleware.js';

const router = express.Router();
const internal = [authenticate, requireInternal];
const admin = [authenticate, requireInternal, requireAdmin];

// ── Coleções específicas (antes de /:id) ──
router.get('/dashboard', ...internal, checklistController.dashboard);
router.get('/my-tasks', ...internal, checklistController.myTasks);
router.get('/users', ...internal, checklistController.listUsers);
router.get('/enterprises', ...internal, checklistController.listEnterprises);
router.post('/import/excel', ...internal, uploadExcelSingle, checklistController.importExcel);

// ── Cobrança (régua configurável) — admin ──
router.get('/cobranca/settings', ...admin, checklistController.getCobrancaSettings);
router.put('/cobranca/settings', ...admin, checklistController.updateCobrancaSettings);
router.get('/cobranca/rules', ...admin, checklistController.listRules);
router.post('/cobranca/rules', ...admin, checklistController.createRule);
router.patch('/cobranca/rules/:id(\\d+)', ...admin, checklistController.updateRule);
router.delete('/cobranca/rules/:id(\\d+)', ...admin, checklistController.removeRule);
router.post('/cobranca/run', ...admin, checklistController.runCobranca);

// ── Catálogo de status (escrita = admin) ──
router.get('/statuses', ...internal, checklistController.listStatuses);
router.post('/statuses', ...admin, checklistController.createStatus);
router.patch('/statuses/:id(\\d+)', ...admin, checklistController.updateStatus);
router.delete('/statuses/:id(\\d+)', ...admin, checklistController.removeStatus);

// ── Modelos (biblioteca) ──
router.get('/templates', ...internal, checklistController.listTemplates);
router.get('/templates/:id(\\d+)', ...internal, checklistController.getTemplate);
router.post('/templates/:id(\\d+)/instantiate', ...internal, checklistController.instantiate);

// ── Seções (por id) ──
router.patch('/sections/:id(\\d+)', ...internal, checklistController.updateSection);
router.delete('/sections/:id(\\d+)', ...internal, checklistController.removeSection);

// ── Tarefas (flat, por id) ──
router.post('/tasks/reorder', ...internal, checklistController.reorderTasks);
router.post('/tasks/bulk', ...internal, checklistController.bulkTasks);
router.get('/tasks/:id(\\d+)', ...internal, checklistController.getTask);
router.patch('/tasks/:id(\\d+)', ...internal, checklistController.updateTask);
router.delete('/tasks/:id(\\d+)', ...internal, checklistController.removeTask);
router.post('/tasks/:id(\\d+)/status', ...internal, checklistController.setTaskStatus);
router.post('/tasks/:id(\\d+)/nudge', ...internal, checklistController.nudgeTask);
router.get('/tasks/:id(\\d+)/comments', ...internal, checklistController.listComments);
router.post('/tasks/:id(\\d+)/comments', ...internal, checklistController.addComment);
router.post('/tasks/:id(\\d+)/attachments', ...internal, checklistController.addAttachment);

// ── Comentários / anexos (delete por id próprio) ──
router.delete('/comments/:id(\\d+)', ...internal, checklistController.removeComment);
router.delete('/attachments/:id(\\d+)', ...internal, checklistController.removeAttachment);

// ── Checklists (CRUD) + sub-recursos por checklist id ──
router.get('/', ...internal, checklistController.list);
router.post('/', ...internal, checklistController.create);
router.get('/:id(\\d+)', ...internal, checklistController.getOne);
router.patch('/:id(\\d+)', ...internal, checklistController.update);
router.post('/:id(\\d+)/archive', ...internal, checklistController.archive);
router.delete('/:id(\\d+)', ...admin, checklistController.remove);
router.post('/:id(\\d+)/sections', ...internal, checklistController.addSection);
router.post('/:id(\\d+)/tasks', ...internal, checklistController.createTask);
router.get('/:id(\\d+)/cobranca', ...internal, checklistController.getChecklistCobranca);
router.put('/:id(\\d+)/cobranca', ...internal, checklistController.setChecklistCobranca);

export default router;
