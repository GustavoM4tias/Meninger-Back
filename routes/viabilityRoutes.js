// src/routes/viabilityRoutes.js
import express from 'express';
import { getEnterpriseViability, getEnterprisesViability } from '../controllers/viabilityController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = express.Router();

// Ex.: GET /api/viability/enterprise/80001?year=2025&aliasId=default&cvEnterpriseId=123&costCenterId=80001
router.get('/enterprise/:erpId', authenticate, getEnterpriseViability);

// ✅ NOVO: viabilidade de TODOS os empreendimentos com projeção no ano/alias
// Ex.: GET /api/viability/enterprises?year=2025&aliasId=default
router.get('/enterprises', authenticate, getEnterprisesViability);

export default router;
