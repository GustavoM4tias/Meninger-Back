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
    reverterAcao, salvarSettings, sugestoesDePromocao, acharProcesso,
    revogarRegra, restaurarRegra, evidenciaDaRegra, listarAcoes, trilhaDe, saudeDoMotor,
} from '../services/processos/processoService.js';
import { minerarTudo, minerarProcesso } from '../services/processos/mineracao.js';
import processosScheduler from '../scheduler/processosScheduler.js';

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

// ── Memória ──────────────────────────────────────────────────────────────────

/**
 * A trilha: o que o motor observou, propôs, o que foi decidido e o que ele
 * executou, em ordem. É a sinopse que a tela não tinha.
 */
router.get('/trilha', requireCapability(ROTA, 'view'), async (req, res) => {
    try {
        res.json({
            success: true,
            data: await trilhaDe({
                processo_key: req.query.processo || null,
                dias: Number(req.query.dias) || 45,
                limite: Number(req.query.limite) || 120,
            }),
        });
    } catch (err) { falhar(res, err, 'GET /trilha'); }
});

/**
 * As ações automáticas. É esta tela que destrava subir um processo para
 * "agir": promover sem ter onde ver e onde desfazer é a promoção que ninguém
 * deveria fazer.
 */
router.get('/acoes', requireCapability(ROTA, 'view'), async (req, res) => {
    try {
        res.json({
            success: true,
            data: await listarAcoes({
                processo_key: req.query.processo || null,
                limite: Number(req.query.limite) || 100,
            }),
        });
    } catch (err) { falhar(res, err, 'GET /acoes'); }
});

router.get('/saude', requireCapability(ROTA, 'view'), async (req, res) => {
    try { res.json({ success: true, data: await saudeDoMotor({ semanas: Number(req.query.semanas) || 8 }) }); }
    catch (err) { falhar(res, err, 'GET /saude'); }
});

/** A cadeia de uma regra: proposta, casos que a sustentaram e ações que moveu. */
router.get('/processos/:key/regras/:id/evidencia', requireCapability(ROTA, 'aprovar'), async (req, res) => {
    try { res.json({ success: true, data: await evidenciaDaRegra(req.params.key, Number(req.params.id)) }); }
    catch (err) { falhar(res, err, 'GET /regras/:id/evidencia'); }
});

/**
 * Revoga uma regra aprovada.
 *
 * Fica em 'aprovar' e não em admin: quem viu a regra errada precisa poder
 * puxar o freio sem procurar ninguém. Puxar o freio é sempre mais fácil que
 * soltá-lo, e é assim que tem que ser.
 */
router.post('/processos/:key/regras/:id/revogar', requireCapability(ROTA, 'aprovar'), async (req, res) => {
    try {
        const r = await revogarRegra(req.params.key, Number(req.params.id), req.user?.id, req.body?.motivo);
        res.json({ success: true, data: r });
    } catch (err) { falhar(res, err, 'POST /regras/:id/revogar'); }
});

/** Devolve ao mapa uma regra revogada por engano. O histórico da revogação fica. */
router.post('/processos/:key/regras/:id/restaurar', requireCapability(ROTA, 'aprovar'), async (req, res) => {
    try {
        const r = await restaurarRegra(req.params.key, Number(req.params.id), req.user?.id);
        res.json({ success: true, data: r });
    } catch (err) { falhar(res, err, 'POST /regras/:id/restaurar'); }
});

router.get('/promocoes', requireCapability(ROTA, 'view'), async (req, res) => {
    try { res.json({ success: true, data: await sugestoesDePromocao() }); }
    catch (err) { falhar(res, err, 'GET /promocoes'); }
});

router.put('/settings', requireCapability(ROTA, 'configurar'), async (req, res) => {
    try {
        const data = await salvarSettings(req.body || {}, req.user?.id);
        // O horário novo vale na hora, sem deploy: é a razão de ele morar em
        // tabela em vez de env.
        processosScheduler.reload().catch(e => console.warn('[processos] scheduler não recarregou:', e?.message));
        res.json({ success: true, data });
    } catch (err) { falhar(res, err, 'PUT /settings'); }
});

/**
 * ENSAIO. Roda a coleta e a mineração SEM GRAVAR NADA e devolve o que faria.
 *
 * Existe porque os coletores leem tabelas do CV cuja semântica ninguém
 * consegue conferir sem olhar dado real: `data_contrato_liberado` é mesmo
 * quando o repasse travou? `ultima_data_conversao` é mesmo quando o lead
 * andou? A forma responsável de ligar isto é ver a saída antes de deixá-la
 * escrever - e é mais barato descobrir aqui que o coletor entendeu errado do
 * que depois de 400 observações gravadas com o sentido trocado.
 *
 * Custa chamadas de IA (a redação roda), então fica atrás de 'configurar'.
 */
router.post('/minerar/ensaio', requireCapability(ROTA, 'configurar'), async (req, res) => {
    try {
        const key = req.body?.processo_key;
        if (key) {
            const p = await acharProcesso(key);
            return res.json({ success: true, data: await minerarProcesso(p.get({ plain: true }), { seco: true }) });
        }
        res.json({ success: true, data: await minerarTudo({ seco: true }) });
    } catch (err) { falhar(res, err, 'POST /minerar/ensaio'); }
});

/** Roda a mineração DE VERDADE agora, sem esperar a madrugada. */
router.post('/minerar', requireCapability(ROTA, 'configurar'), async (req, res) => {
    try { res.json({ success: true, data: await minerarTudo({ seco: false }) }); }
    catch (err) { falhar(res, err, 'POST /minerar'); }
});

export default router;
