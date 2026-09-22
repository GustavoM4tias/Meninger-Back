// routes/orgRoutes.js
//
// Leituras NÃO-admin do registro unificado de empreendimentos.
// Hoje: rótulos (nome/cidade por CC e CV id) para Títulos/Custos — sempre
// limitados ao escopo do usuário (admin vê todos).

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import { listEnterpriseLabels, listEnterpriseCatalog } from '../controllers/orgRegistryController.js';

const router = express.Router();

router.get(
    '/enterprise-labels',
    authenticate,
    requireRoutePermission(['/financeiro/custos', '/financeiro/titulos']),
    listEnterpriseLabels
);

// Catálogo de empreendimentos do CV: { id (cv), nome ATUAL, cidade, uf },
// ordenado por id. É o que o front carrega uma vez por sessão para rotular
// qualquer id - o nome gravado nas linhas é rótulo da época, nunca a chave.
// Não é dado sensível (nome e cidade de empreendimento); o recorte de acesso
// continua onde sempre esteve: nos dados de cada tela.
router.get('/enterprises/catalog', authenticate, listEnterpriseCatalog);

export default router;
