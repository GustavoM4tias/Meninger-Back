// routes/processosRoutes.js
//
// API do motor de processos (tela /tools/eme-processos).
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ESTA TELA NÃO É TRAVADA EM CÓDIGO
//
// Quem entende o processo comercial é o gestor comercial, não o administrador
// do sistema. Travar em `requireAdmin` faria toda regra esperar uma pessoa que
// não é dona do assunto, e o laço de aprendizado morre na segunda semana -
// não por falta de tecnologia, por fila parada.
//
// Então a tela é DELEGÁVEL e cada ação tem a sua capacidade
// (lib/screenCapabilities.js). A linha que importa está ali:
//
//   aprovar     'screen'  o que é certo a empresa fazer
//   autonomia   'admin'   se a IA passa a fazer sozinha
//
// São decisões de peso diferente, e misturá-las numa permissão só é como uma
// aprovação de regra vira, sem ninguém perceber, uma autorização para agir.
//
// Se em algum momento a tela precisar ser só do admin, o caminho é o cadeado
// da tela de Alçadas (route_policies) - vale na hora, sem deploy.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireCapability from '../middlewares/requireCapability.js';
import {
    paraTela, listarProcessos, salvarProcesso, trocarAutonomia,
    filaDePropostas, decidirProposta, observacoesDe,
    reverterAcao, salvarSettings, sugestoesDePromocao,
} from '../services/processos/processoService.js';

const ROTA = '/tools/eme-processos';
const router = express.Router();
router.use(authenticate);

function falhar(res, err, onde) {
    const status = err?.expose || 500;
    if (status >= 500) console.error(`[processos] ${onde}:`, err);
    res.status(status).json({ success: false, message: status >= 500 ? 'Erro ao processar a solicitação.' : err.message });
}

/** Tudo o que a tela abre de uma vez: mapa, fila, sugestões e configuração. */
router.get('/', requireCapability(ROTA, 'view'), async (req, res) => {
    try { res.json({ success: true, data: await paraTela() }); }
    catch (err) { falhar(res, err, 'GET /'); }
});

router.get('/processos', requireCapability(ROTA, 'view'), async (req, res) => {
    try { res.json({ success: true, data: await listarProcessos() }); }
    catch (err) { falhar(res, err, 'GET /processos'); }
});

/**
 * Edita o processo (nome, gatilho, etapas, exceções).
 *
 * Fica em 'aprovar' e não em 'view': corrigir as etapas é reescrever o mapa da
 * empresa, mesmo quando parece só texto.
 */
router.put('/processos/:key', requireCapability(ROTA, 'aprovar'), async (req, res) => {
    try { res.json({ success: true, data: await salvarProcesso(req.params.key, req.body || {}, req.user?.id) }); }
    catch (err) { falhar(res, err, 'PUT /processos/:key'); }
});

/** O degrau de autonomia e o teto. Admin, e por rota própria. */
router.put('/processos/:key/autonomia', requireCapability(ROTA, 'autonomia'), async (req, res) => {
    try { res.json({ success: true, data: await trocarAutonomia(req.params.key, req.body || {}, req.user?.id) }); }
    catch (err) { falhar(res, err, 'PUT /autonomia'); }
});

/**
 * As observações de um processo. É o dado CRU, com escopo de origem - por isso
 * exige 'aprovar' e não 'view': quem só acompanha o mapa lê as REGRAS, que já
 * passaram pela régua de largura. Ver o cru é para quem julga a evidência.
 */
router.get('/processos/:key/observacoes', requireCapability(ROTA, 'aprovar'), async (req, res) => {
    try {
        const limite = Math.min(500, Math.max(1, Number(req.query.limite) || 100));
        res.json({ success: true, data: await observacoesDe(req.params.key, { limite }) });
    } catch (err) { falhar(res, err, 'GET /observacoes'); }
});

router.get('/fila', requireCapability(ROTA, 'view'), async (req, res) => {
    try {
        const incluirParadas = req.query.paradas === 'true';
        res.json({ success: true, data: await filaDePropostas({ incluirParadas }) });
    } catch (err) { falhar(res, err, 'GET /fila'); }
});

/** O único caminho que transforma proposta em regra da empresa. */
router.post('/propostas/:id/:decisao', requireCapability(ROTA, 'aprovar'), async (req, res) => {
    try {
        const r = await decidirProposta(
            Number(req.params.id), req.params.decisao, req.user?.id, req.body?.nota,
        );
        res.json({ success: true, data: r });
    } catch (err) { falhar(res, err, 'POST /propostas/:id/:decisao'); }
});

/**
 * Marca uma ação automática como desfeita. Rebaixa o processo na hora.
 *
 * Fica em 'aprovar' e não em 'autonomia' de propósito: quem viu a ação errada
 * precisa poder desfazê-la sem procurar o admin. Puxar o freio é sempre mais
 * fácil que soltá-lo.
 */
router.post('/acoes/:id/reverter', requireCapability(ROTA, 'aprovar'), async (req, res) => {
    try {
        const r = await reverterAcao(Number(req.params.id), req.user?.id, req.body?.nota, req.body?.tipo);
        res.json({ success: true, data: r });
    } catch (err) { falhar(res, err, 'POST /acoes/:id/reverter'); }
});

router.get('/promocoes', requireCapability(ROTA, 'view'), async (req, res) => {
    try { res.json({ success: true, data: await sugestoesDePromocao() }); }
    catch (err) { falhar(res, err, 'GET /promocoes'); }
});

router.put('/settings', requireCapability(ROTA, 'configurar'), async (req, res) => {
    try { res.json({ success: true, data: await salvarSettings(req.body || {}, req.user?.id) }); }
    catch (err) { falhar(res, err, 'PUT /settings'); }
});

export default router;
