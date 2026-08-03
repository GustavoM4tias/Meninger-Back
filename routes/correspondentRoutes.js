// routes/correspondentRoutes.js
//
// Correspondentes (CV) - rotas autenticadas da tela do Office.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireRoutePermission from '../middlewares/requireRoutePermission.js';
import {
    getOverview,
    syncCorrespondents,
    previewPaste,
    listCompanies,
    createCompany,
    resendCompany,
    linkCompany,
    updateCompany,
    createUsers,
    listRegistrations,
    retryRegistration,
    listInvites,
    createInvite,
    revokeInvite,
} from '../controllers/correspondentController.js';

const router = express.Router();

router.use(authenticate, requireInternal, requireRoutePermission(['/comercial/correspondentes']));

router.get('/overview', getOverview);
router.post('/sync', syncCorrespondents);

router.get('/companies', listCompanies);
router.post('/companies', createCompany);
router.put('/companies/:id', updateCompany);
router.post('/companies/:id/link', linkCompany);
router.post('/companies/:id/resend', resendCompany);

router.post('/preview', previewPaste);
router.post('/users', createUsers);

router.get('/registrations', listRegistrations);
router.post('/registrations/:id/retry', retryRegistration);

router.get('/invites', listInvites);
router.post('/invites', createInvite);
router.post('/invites/:id/revoke', revokeInvite);

export default router;
