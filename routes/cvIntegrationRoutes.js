// routes/cvIntegrationRoutes.js — CV CRM > Integrações
//
// Administração da integração com o CV: os webhooks cadastrados lá, os
// endpoints que recebem aqui, e o histórico de execuções.
//
// TUDO admin-only por código, e não por cadeado na tela de Alçadas. É a
// exceção que o CLAUDE.md prevê: administração do PRÓPRIO SISTEMA. Quem mexe
// aqui redireciona para onde o CV manda os eventos e enxerga os tokens que
// autenticam os endpoints públicos - não é trabalho delegável. Por isso os
// três níveis exigidos estão presentes: `adminOnly` no navRegistry,
// `requiresAdmin` no meta da rota do front e `requireAdmin` aqui.
//
// O endpoint que o CV CHAMA não está aqui: é público, mora em cvRoutes.js e
// se autentica pelo token na URL.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';

import {
    listar,
    gatilhos,
    criar,
    apagar,
    padronizarNome,
    alternarAtivo,
} from '../controllers/cv/cvIntegrationController.js';

import {
    salvarEndpoint,
    regenerarToken,
    listarEventos,
    resumoEventos,
    reprocessarEntidade,
} from '../controllers/cv/webhookController.js';

const router = express.Router();

router.use(authenticate, requireAdmin);

// ── Lado do CV: o que está cadastrado lá ─────────────────────────────────────
router.get('/webhooks', listar);
router.get('/gatilhos', gatilhos);
router.post('/webhooks', criar);
router.delete('/webhooks/:id', apagar);
router.post('/webhooks/:id/padronizar-nome', padronizarNome);
// Ligar/desligar no CV tambem recria: a API nao tem PUT.
router.post('/webhooks/:id/alternar-ativo', alternarAtivo);

// ── Lado do Office: os endpoints que recebem ─────────────────────────────────
router.patch('/endpoints/:funcionalidade', salvarEndpoint);
router.post('/endpoints/:funcionalidade/regenerar-token', regenerarToken);
router.post('/endpoints/:funcionalidade/reprocessar', reprocessarEntidade);

// ── Histórico: todas as funcionalidades, todas as origens ────────────────────
router.get('/eventos', listarEventos);
router.get('/eventos/resumo', resumoEventos);

export default router;
