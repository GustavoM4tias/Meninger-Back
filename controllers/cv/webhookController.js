// controllers/cv/webhookController.js
//
// Endpoint público do webhook do CV + a administração dele pela tela.
//
// O endpoint público segue o formato dos outros três webhooks de CV que já
// existem no Office (Boleto Caixa, Cancelamento de Reservas, CONTRATOS_IA):
// segredo na URL, resposta imediata e trabalho em segundo plano. A entrada na
// allowlist de security/integrityCheck.js é obrigatória - ver CLAUDE.md.

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import { extrairId, agendarProcessamento, reprocessar } from '../../services/cv/cvWebhookService.js';
import { registrar, listar, resumo } from '../../services/cv/cvIntegrationLog.js';

// ── Endpoint público ─────────────────────────────────────────────────────────

/**
 * POST /api/cv/webhook/:funcionalidade/:token
 *
 * Responde 200 SEMPRE que o token confere, mesmo quando o evento não vai ser
 * processado. Um webhook que devolve erro por regra de negócio ensina o
 * emissor a desistir: vários provedores desativam o gancho depois de N falhas.
 * O que aconteceu com o evento fica no histórico, que é onde essa resposta
 * pertence.
 *
 * Token errado é 404, não 401: dizer "existe, mas seu token está errado"
 * confirma o caminho para quem está sondando.
 */
export async function receberWebhook(req, res) {
    const { funcionalidade, token } = req.params;

    let endpoint = null;
    try {
        endpoint = await db.CvWebhookEndpoint.findByPk(String(funcionalidade || ''));
    } catch (err) {
        console.error('[CV webhook] falha ao ler o endpoint:', err?.message);
        return res.status(500).json({ error: 'Erro interno.' });
    }

    if (!endpoint || !endpoint.token || !tokenConfere(endpoint.token, token)) {
        return res.status(404).json({ error: 'Não encontrado.' });
    }

    if (!endpoint.active) {
        // Registrado, porque "o CV continua chamando um webhook que eu
        // desliguei" é exatamente o tipo de coisa que ninguém descobre sozinho.
        await registrar({
            origem: 'webhook',
            funcionalidade: endpoint.funcionalidade,
            status: 'ignorado',
            mensagem: 'Endpoint desligado na tela; o evento foi descartado.',
            payload: req.body,
        });
        return res.status(200).json({ received: true, processado: false });
    }

    const idEntidade = extrairId(req.body, endpoint.funcionalidade);

    // Responde antes de processar: o trabalho envolve chamar o próprio CV de
    // volta, e segurar a conexão até lá faria o CV estourar por timeout.
    res.status(200).json({ received: true, id: idEntidade });

    agendarProcessamento({ endpoint, idEntidade, corpo: req.body });
}

/** Comparação em tempo constante - o token é o que autentica esta rota. */
function tokenConfere(esperado, recebido) {
    const a = Buffer.from(String(esperado));
    const b = Buffer.from(String(recebido || ''));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ── Administração (tela CV CRM) ──────────────────────────────────────────────

/** GET /api/cv/webhooks - configuração + saúde de cada funcionalidade. */
export async function listarEndpoints(req, res) {
    try {
        const linhas = await db.CvWebhookEndpoint.findAll({ order: [['funcionalidade', 'ASC']] });
        // Mesma convenção do webhook da Meta (marketingConfigController).
        const base = (process.env.PUBLIC_BACKEND_URL || 'https://menin.up.railway.app').replace(/\/+$/, '');

        return res.json(linhas.map(l => ({
            funcionalidade: l.funcionalidade,
            active: l.active,
            processa: l.processa,
            descricao: l.descricao,
            // A URL pronta para colar no CV. Sem isso, montar a mão é onde o
            // erro acontece - e o token está aqui de propósito: quem tem a tela
            // é quem configura a integração.
            url: `${base}/api/cv/webhook/${l.funcionalidade}/${l.token}`,
            last_event_at: l.last_event_at,
            last_status: l.last_status,
            last_message: l.last_message,
            eventos_recebidos: Number(l.eventos_recebidos || 0),
        })));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/** PATCH /api/cv/webhooks/:funcionalidade - liga/desliga e modo escuta. */
export async function salvarEndpoint(req, res) {
    try {
        const endpoint = await db.CvWebhookEndpoint.findByPk(req.params.funcionalidade);
        if (!endpoint) return res.status(404).json({ error: 'Funcionalidade desconhecida.' });

        const patch = {};
        if (req.body?.active !== undefined) patch.active = !!req.body.active;
        if (req.body?.processa !== undefined) patch.processa = !!req.body.processa;
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada a salvar.' });

        await endpoint.update(patch);
        await registrar({
            origem: 'manual',
            funcionalidade: endpoint.funcionalidade,
            status: 'ok',
            mensagem: `Configuração alterada por ${req.user?.email || 'admin'}: `
                    + `${patch.active !== undefined ? `recebimento ${patch.active ? 'ligado' : 'desligado'}; ` : ''}`
                    + `${patch.processa !== undefined ? `modo ${patch.processa ? 'processando' : 'escuta'}` : ''}`,
        });
        return listarEndpoints(req, res);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/cv/webhooks/:funcionalidade/regenerar-token
 * Invalida a URL antiga na hora - quem faz isso precisa colar a nova no CV.
 */
export async function regenerarToken(req, res) {
    try {
        const endpoint = await db.CvWebhookEndpoint.findByPk(req.params.funcionalidade);
        if (!endpoint) return res.status(404).json({ error: 'Funcionalidade desconhecida.' });

        await endpoint.update({ token: crypto.randomBytes(24).toString('hex') });
        await registrar({
            origem: 'manual',
            funcionalidade: endpoint.funcionalidade,
            status: 'ok',
            mensagem: `Token regenerado por ${req.user?.email || 'admin'}. A URL anterior parou de valer.`,
        });
        return listarEndpoints(req, res);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/** GET /api/cv/integration-events - histórico de TODAS as funcionalidades. */
export async function listarEventos(req, res) {
    try {
        const { funcionalidade, origem, status, entidade_id, limite, offset } = req.query;
        const dados = await listar({ funcionalidade, origem, status, entidade_id, limite, offset });
        return res.json(dados);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/** GET /api/cv/integration-events/resumo - contagem das últimas 24h. */
export async function resumoEventos(req, res) {
    try {
        return res.json(await resumo());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/cv/webhooks/:funcionalidade/reprocessar { id }
 * Mesma execução do webhook, para recuperar um evento que se perdeu.
 */
export async function reprocessarEntidade(req, res) {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Informe o id da entidade.' });
    }
    try {
        const stats = await reprocessar({
            funcionalidade: req.params.funcionalidade,
            idEntidade: id,
            usuarioId: req.user?.id || null,
        });
        return res.json({ ok: true, stats });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

export default {
    receberWebhook,
    listarEndpoints,
    salvarEndpoint,
    regenerarToken,
    listarEventos,
    resumoEventos,
    reprocessarEntidade,
};
