// routes/realEstateRoutes.js
//
// Cadastro de imobiliárias — rotas autenticadas da tela do Office.
//
// A permissão de cada rota vem da MESMA linha que o front usa para esconder o
// botão (lib/screenCapabilities.js → '/crm/imobiliarias'), no padrão de
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
    getCvPanel,
    updateCvPanel,
    testCvPanel,
    getCvJobs,
    updateCvJob,
    runCvJob,
    testCvApi,
    getCvRobo,
    conectarCvRobo,
    desconectarCvRobo,
    salvarCvRoboConfig,
    simularCvRobo,
    avaliarCvRobo,
} from '../controllers/realEstateController.js';


const TELA = '/crm/imobiliarias';
const podeVer = requireCapability(TELA, 'view');
const podeCadastrar = requireCapability(TELA, 'register');
const podeSincronizar = requireCapability(TELA, 'sync');
const podeConfigurar = requireCapability(TELA, 'configure');

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

// Credencial do painel do CV (v3) + quem é avisado quando ela para de valer.
router.get('/cv-panel', podeConfigurar, getCvPanel);
router.put('/cv-panel', podeConfigurar, updateCvPanel);
router.post('/cv-panel/test', podeConfigurar, testCvPanel);
router.post('/cv-panel/test-api', podeConfigurar, testCvApi);

// Robô do painel: sessão colada por uma pessoa, regra e histórico da
// reaprovação automática de reservas.
router.get('/cv-robo', podeConfigurar, getCvRobo);
router.put('/cv-robo/sessao', podeConfigurar, conectarCvRobo);
router.delete('/cv-robo/sessao', podeConfigurar, desconectarCvRobo);
router.put('/cv-robo/config', podeConfigurar, salvarCvRoboConfig);
router.post('/cv-robo/simular', podeConfigurar, simularCvRobo);
router.post('/cv-robo/avaliar', podeConfigurar, avaliarCvRobo);

// Crons de dados do CV: o que roda e em que horário.
router.get('/cv-jobs', podeConfigurar, getCvJobs);
router.put('/cv-jobs/:key', podeConfigurar, updateCvJob);
router.post('/cv-jobs/:key/run', podeConfigurar, runCvJob);

// A integração com o CV (webhooks, endpoints e histórico) tem tela própria:
// CV CRM > Integrações, em routes/cvIntegrationRoutes.js. É admin-only por
// código, porque quem mexe lá enxerga os tokens dos endpoints públicos.

export default router;
