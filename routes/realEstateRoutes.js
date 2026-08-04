// routes/realEstateRoutes.js
//
// Cadastro de imobiliárias — rotas autenticadas da tela do Office.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import upload from '../middlewares/uploadMiddleware.js';
import {
    listRegistrations,
    createInvite,
    updateInvite,
    revokeInvite,
    createInternalRegistration,
    retryRegistration,
    parseCardAuthenticated,
    getImobiliariasReport,
    syncImobiliarias,
} from '../controllers/realEstateController.js';

const router = express.Router();

router.use(authenticate, requireInternal, requireRoutePermission(['/comercial/imobiliarias']));

router.get('/registrations', listRegistrations);
router.post('/registrations', createInternalRegistration);
router.post('/registrations/:id/retry', retryRegistration);

router.post('/invites', createInvite);
router.patch('/invites/:id', updateInvite);
router.post('/invites/:id/revoke', revokeInvite);

router.post('/parse-cnpj-card', upload.single('file'), parseCardAuthenticated);

// Relatório de imobiliárias (backup local do CV)
router.get('/report', getImobiliariasReport);
router.post('/sync', syncImobiliarias);

export default router;
