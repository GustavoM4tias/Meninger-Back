// routes/realEstateRoutes.js
//
// Cadastro de imobiliárias — rotas autenticadas da tela do Office.
//
// A permissão de cada rota vem da MESMA linha que o front usa para esconder o
// botão (lib/screenCapabilities.js → '/comercial/imobiliarias'), no padrão de
// capacidades. Ler é `view`, escrever no CV é `register`, e a varredura
// completa é `sync` (admin).

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireCapability from '../middlewares/requireCapability.js';
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

const TELA = '/comercial/imobiliarias';
const podeVer = requireCapability(TELA, 'view');
const podeCadastrar = requireCapability(TELA, 'register');
const podeSincronizar = requireCapability(TELA, 'sync');

const router = express.Router();

router.use(authenticate, requireInternal);

router.get('/registrations', podeVer, listRegistrations);
router.post('/registrations', podeCadastrar, createInternalRegistration);
router.post('/registrations/:id/retry', podeCadastrar, retryRegistration);

router.post('/invites', podeCadastrar, createInvite);
router.patch('/invites/:id', podeCadastrar, updateInvite);
router.post('/invites/:id/revoke', podeCadastrar, revokeInvite);

router.post('/parse-cnpj-card', podeCadastrar, upload.single('file'), parseCardAuthenticated);

// Relatório de imobiliárias (backup local do CV)
router.get('/report', podeVer, getImobiliariasReport);
router.post('/sync', podeSincronizar, syncImobiliarias);

export default router;
