// routes/realEstateRoutes.js
//
// Cadastro de imobiliárias — rotas autenticadas da tela do Office.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import upload from '../middlewares/uploadMiddleware.js';
import {
    listRegistrations,
    createInvite,
    revokeInvite,
    createInternalRegistration,
    retryRegistration,
    parseCardAuthenticated,
} from '../controllers/realEstateController.js';

const router = express.Router();

router.use(authenticate, requireInternal);

router.get('/registrations', listRegistrations);
router.post('/registrations', createInternalRegistration);
router.post('/registrations/:id/retry', retryRegistration);

router.post('/invites', createInvite);
router.post('/invites/:id/revoke', revokeInvite);

router.post('/parse-cnpj-card', upload.single('file'), parseCardAuthenticated);

export default router;
