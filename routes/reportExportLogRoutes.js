import express from 'express';
import authMiddleware from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import { recordExport, listExports } from '../controllers/reportExportLogController.js';

const router = express.Router();

// Registrar a própria exportação — qualquer usuário autenticado.
router.post('/', authMiddleware, recordExport);

// Consultar a trilha — restrito ao admin.
router.get('/', authMiddleware, requireAdmin, listExports);

export default router;
