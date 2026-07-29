// routes/orgRoutes.js
//
// Leituras NÃO-admin do registro unificado de empreendimentos.
// Hoje: rótulos (nome/cidade por CC e CV id) para Títulos/Custos — sempre
// limitados ao escopo do usuário (admin vê todos).

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import { listEnterpriseLabels } from '../controllers/orgRegistryController.js';

const router = express.Router();

router.get(
    '/enterprise-labels',
    authenticate,
    requireRoutePermission(['/financeiro/custos', '/financeiro/titulos']),
    listEnterpriseLabels
);

export default router;
