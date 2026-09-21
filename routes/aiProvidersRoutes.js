// routes/aiProvidersRoutes.js
//
// API da tela Conexões de IA. Admin-only nos três níveis que a casa exige
// (navRegistry + meta da rota + este `requireAdmin`), porque aqui se lê e se
// escreve CREDENCIAL: quem entra nesta tela passa a poder mandar a operação
// inteira para outro fornecedor.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTA API NUNCA FAZ
//
// Devolver chave. O GET entrega `{ total, finais: ['****a1b2'] }` - o bastante
// para reconhecer qual chave está ali, e nada que sirva para usá-la. Chave que
// a API devolve é chave que vaza no cache do navegador, no log do proxy e no
// print que alguém manda no grupo. Por isso o campo da tela é de ESCRITA: sai
// preenchido de lá, nunca volta preenchido de cá.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE TESTAR É UMA ROTA, E NÃO UM "SALVAR E TORCER"
//
// Chave trocada errada só aparece na próxima pergunta de alguém - e aparece
// como "a Eme parou", não como "a chave está errada". O POST /:id/testar faz um
// ping real em cada modelo do pool e grava o resultado, então a tela mostra a
// verdade do fornecedor e não a intenção de quem salvou.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import db from '../models/sequelize/index.js';
import {
    paraTela, salvarProvider, removerProvider, salvarRota,
    CONTEXTOS, TIPOS, USOS,
} from '../services/ai/providers.js';
import { testarProvedor, limparCooldowns } from '../services/ai/gateway.js';

const router = express.Router();
router.use(authenticate, requireAdmin);

/** Erro validado responde 400/404 com o recado; o resto vira 500 genérico. */
function falhar(res, err, ondeDeu) {
    const status = err?.expose || 500;
    if (status >= 500) console.error(`[aiProviders] ${ondeDeu}:`, err);
    res.status(status).json({ success: false, message: status >= 500 ? 'Erro ao processar a solicitação.' : err.message });
}

/** GET /api/ai-providers -> provedores (sem credencial), contextos e vocabulário. */
router.get('/', async (req, res) => {
    try {
        const dados = await paraTela();
        res.json({ success: true, data: { ...dados, contextos: CONTEXTOS, tipos: TIPOS, usos: USOS } });
    } catch (err) { falhar(res, err, 'GET /'); }
});

router.post('/', async (req, res) => {
    try {
        const row = await salvarProvider(null, req.body || {}, req.user?.id);
        res.status(201).json({ success: true, data: { id: row.id, key: row.key } });
    } catch (err) { falhar(res, err, 'POST /'); }
});

router.put('/:id', async (req, res) => {
    try {
        const row = await salvarProvider(Number(req.params.id), req.body || {}, req.user?.id);
        // Credencial nova merece fila limpa: a chave velha pode ter ficado em
        // quarentena por quota, e o cooldown de 5 min faria o admin achar que a
        // chave nova também não presta.
        if (req.body?.api_keys !== undefined) limparCooldowns();
        res.json({ success: true, data: { id: row.id, key: row.key } });
    } catch (err) { falhar(res, err, 'PUT /:id'); }
});

router.delete('/:id', async (req, res) => {
    try {
        await removerProvider(Number(req.params.id));
        res.json({ success: true });
    } catch (err) { falhar(res, err, 'DELETE /:id'); }
});

/** PUT /api/ai-providers/rotas/:contexto -> quem atende este contexto. */
router.put('/rotas/:contexto', async (req, res) => {
    try {
        const row = await salvarRota(req.params.contexto, req.body || {}, req.user?.id);
        res.json({ success: true, data: { contexto: row.contexto } });
    } catch (err) { falhar(res, err, 'PUT /rotas/:contexto'); }
});

/**
 * POST /api/ai-providers/:id/testar -> ping real em cada modelo do pool.
 *
 * Gasta alguns tokens de propósito: o objetivo é descobrir o problema AQUI, e
 * não na próxima pergunta de alguém.
 */
router.post('/:id/testar', async (req, res) => {
    try {
        const provider = await db.AiProvider.findByPk(Number(req.params.id));
        if (!provider) return res.status(404).json({ success: false, message: 'Provedor não encontrado.' });
        const r = await testarProvedor(provider.get({ plain: true }));
        res.json({ success: true, data: r });
    } catch (err) { falhar(res, err, 'POST /:id/testar'); }
});

export default router;
