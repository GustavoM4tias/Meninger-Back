// /routes/permissionRoutes.js
import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import {
    getMyPermissions, getAllPermissions, setUserPermissions,
    getGrants, setGrants, getEnterpriseOptions,
    getRoutePolicies, putRoutePolicy,
    getCapabilityCatalog, getGrantsBulk, getRetiredRoutes,
} from '../controllers/permissionController.js';
import {
    getProfiles, createProfile, updateProfile, deleteProfile, resetProfileToDefault,
} from '../controllers/permissionProfileController.js';
import { getMeta, getRules, putRule, deleteRule } from '../controllers/departmentVisibilityController.js';

const router = express.Router();

const adminOnly = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'Acesso restrito a administradores.' });
    }
    next();
};

// Rota do usuário autenticado
router.get('/me', authenticate, getMyPermissions);

// Perfis de alçadas (específico antes do paramétrico /:userId)
router.get('/profiles', authenticate, adminOnly, getProfiles);
router.post('/profiles', authenticate, adminOnly, createProfile);
router.put('/profiles/:id', authenticate, adminOnly, updateProfile);
router.post('/profiles/:id/reset-default', authenticate, adminOnly, resetProfileToDefault);
router.delete('/profiles/:id', authenticate, adminOnly, deleteProfile);

// Telas exclusivas de admin definidas pela própria tela de Alçadas — admin only.
// Declaradas ANTES de /:userId (senão o PUT cairia na rota paramétrica).
router.get('/route-policies', authenticate, adminOnly, getRoutePolicies);
router.put('/route-policies', authenticate, adminOnly, putRoutePolicy);

// Visibilidade de departamento em cascata (global/cargo/usuário) — admin only.
// Declarado ANTES de /:userId (senão o PUT cairia na rota paramétrica).
router.get('/department-visibility/meta', authenticate, adminOnly, getMeta);
router.get('/department-visibility', authenticate, adminOnly, getRules);
router.put('/department-visibility', authenticate, adminOnly, putRule);
router.delete('/department-visibility', authenticate, adminOnly, deleteRule);

// Catálogo de AÇÕES por tela (lib/screenCapabilities.js) — admin only.
// É o que a aba "Telas" da Gestão de Alçadas lê para deixar de ser binária.
router.get('/capabilities', authenticate, adminOnly, getCapabilityCatalog);

// Rotas aposentadas pelo boot — admin only. A tela explica por que uma alçada
// sai sozinha em vez de deixar o admin religar uma rota que some de novo.
router.get('/retired-routes', authenticate, adminOnly, getRetiredRoutes);

// Grants de empreendimento (dados) — admin only. Declarados ANTES de /:userId.
// O plural sem sujeito devolve TODOS de uma vez (fila "sem liberação de dados");
// o por-sujeito continua servindo o modal.
router.get('/grants', authenticate, adminOnly, getGrantsBulk);
router.get('/enterprise-options', authenticate, adminOnly, getEnterpriseOptions);
router.get('/grants/:subjectType/:subjectId', authenticate, adminOnly, getGrants);
router.put('/grants/:subjectType/:subjectId', authenticate, adminOnly, setGrants);

// Usuários (admin only)
router.get('/', authenticate, adminOnly, getAllPermissions);
router.put('/:userId', authenticate, adminOnly, setUserPermissions);

export default router;
