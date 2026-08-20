import express from 'express';
import authMiddleware from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import { recordExport, listExports } from '../controllers/reportExportLogController.js';

const router = express.Router();

// Registrar a própria exportação — qualquer usuário autenticado.
router.post('/', authMiddleware, recordExport);

// Consultar a trilha — auditoria da tela de Leads (acao `audit`, so admin).
router.get('/', authMiddleware, requireCapability('/marketing/leads', 'audit'), listExports);

export default router;
