// controllers/cv/cvIntegrationController.js
//
// A tela CV CRM > Integrações: gerência dos webhooks cadastrados NO CV.
//
// O que existe do lado do Office (os endpoints que recebem, o token de cada um
// e o histórico de execuções) fica em webhookController.js; aqui é o outro
// lado da ponte. A tela junta os dois, que é o que faltava para conseguir
// responder "o CV está apontando para o lugar certo?" sem abrir o painel do CV.
//
// Toda operação de ESCRITA no CV entra no histórico da integração. Apagar um
// webhook é irreversível pela API (não há PUT para desfazer, só recriar), e um
// registro de quem fez e quando é o mínimo.

import db from '../../models/sequelize/index.js';
import {
    FUNCIONALIDADES_CV,
    CV_PARA_LOCAL,
    nomePadrao,
    listarGatilhos,
    listarWebhooks,
    criarWebhook,
    apagarWebhook,
    recriarWebhook,
} from '../../services/cv/cvWebhookRegistry.js';
import { registrar } from '../../services/cv/cvIntegrationLog.js';

const baseDoOffice = () =>
    (process.env.PUBLIC_BACKEND_URL || 'https://menin.up.railway.app').replace(/\/+$/, '');

const quem = (req) => req.user?.email || req.user?.username || `usuário ${req.user?.id || '?'}`;

/**
 * GET /api/cv-integracoes/webhooks
 *
 * Devolve os webhooks do CV já cruzados com os endpoints locais: para cada
 * webhook que aponta para o Office, diz se o endpoint correspondente está
 * ligado. É a checagem que pega o erro mais chato dessa integração - o CV
 * chamando um endereço que o Office está ignorando, sem nada quebrar
 * visivelmente de nenhum dos dois lados.
 */
export async function listar(req, res) {
    try {
        const base = baseDoOffice();
        const [webhooks, endpoints] = await Promise.all([
            listarWebhooks(base),
            db.CvWebhookEndpoint.findAll({ order: [['funcionalidade', 'ASC']] }),
        ]);

        const porUrl = new Map();
        for (const e of endpoints) porUrl.set(`${base}/api/cv/webhook/${e.funcionalidade}/${e.token}`, e);

        const enriquecidos = webhooks.map(w => {
            const local = porUrl.get(w.endereco) || null;
            return {
                ...w,
                endpoint_local: local ? local.funcionalidade : null,
                endpoint_ligado: local ? local.active : null,
                endpoint_processa: local ? local.processa : null,
                // Aponta para o Office mas para uma URL que nenhum endpoint
                // local reconhece: token velho depois de uma regeneração, ou um
                // webhook de automação antigo (cancelamento, boleto), que têm
                // rota própria e não passam por cv_webhook_endpoints.
                destino_desconhecido: w.do_office && !local,
            };
        });

        return res.json({
            webhooks: enriquecidos,
            endpoints: endpoints.map(e => ({
                funcionalidade: e.funcionalidade,
                active: e.active,
                processa: e.processa,
                descricao: e.descricao,
                url: `${base}/api/cv/webhook/${e.funcionalidade}/${e.token}`,
                last_event_at: e.last_event_at,
                last_status: e.last_status,
                last_message: e.last_message,
                eventos_recebidos: Number(e.eventos_recebidos || 0),
            })),
            funcionalidades: FUNCIONALIDADES_CV,
            cv_para_local: CV_PARA_LOCAL,
        });
    } catch (err) {
        return res.status(502).json({ error: `Não foi possível ler os webhooks no CV: ${err.message}` });
    }
}

/** GET /api/cv-integracoes/gatilhos - catálogo para o formulário de criação. */
export async function gatilhos(req, res) {
    try {
        return res.json(await listarGatilhos());
    } catch (err) {
        return res.status(502).json({ error: `Não foi possível ler os gatilhos no CV: ${err.message}` });
    }
}

/**
 * POST /api/cv-integracoes/webhooks
 *
 * `destino_local` (reservas|repasses) monta a URL do Office com o token certo,
 * em vez de a pessoa colar à mão - digitar token de 48 caracteres num campo é
 * onde o erro acontece, e o erro só aparece quando o dado deixa de chegar.
 * Um `endereco` livre continua aceito para integrações de terceiros.
 */
export async function criar(req, res) {
    const { nome, funcionalidade, gatilho, gatilho_nome, ativo, destino_local, endereco, idempreendimento } = req.body || {};

    try {
        let url = endereco;
        if (destino_local) {
            const local = await db.CvWebhookEndpoint.findByPk(String(destino_local));
            if (!local) return res.status(400).json({ error: `Endpoint local desconhecido: ${destino_local}` });
            url = `${baseDoOffice()}/api/cv/webhook/${local.funcionalidade}/${local.token}`;
        }

        const criado = await criarWebhook({
            nome: nome || (gatilho_nome ? nomePadrao(funcionalidade, gatilho_nome) : ''),
            funcionalidade,
            endereco: url,
            gatilho,
            ativo: ativo !== false,
            idempreendimento,
        });

        await registrar({
            origem: 'manual',
            funcionalidade: CV_PARA_LOCAL[funcionalidade] || String(funcionalidade || '').toLowerCase(),
            status: 'ok',
            mensagem: `Webhook "${criado.nome}" criado no CV (id ${criado.idwebhook}) por ${quem(req)}.`,
            stats: { acao: 'criar_webhook_cv', idwebhook: criado.idwebhook, gatilho: criado.gatilho },
        });

        return res.status(201).json({ ok: true, webhook: criado });
    } catch (err) {
        await registrar({
            origem: 'manual',
            funcionalidade: CV_PARA_LOCAL[funcionalidade] || String(funcionalidade || '').toLowerCase() || 'cv',
            status: 'erro',
            mensagem: `Falha ao criar webhook no CV (${quem(req)}): ${err.message}`,
        });
        return res.status(502).json({ error: err.message });
    }
}

/** DELETE /api/cv-integracoes/webhooks/:id */
export async function apagar(req, res) {
    try {
        const id = Number(req.params.id);
        // Lê antes de apagar: o registro precisa dizer O QUE foi apagado, não
        // só um número - depois do DELETE não há mais como descobrir.
        const antes = (await listarWebhooks(baseDoOffice())).find(w => w.idwebhook === id) || null;

        await apagarWebhook(id);

        await registrar({
            origem: 'manual',
            funcionalidade: CV_PARA_LOCAL[antes?.funcionalidade] || 'cv',
            status: 'ok',
            mensagem: `Webhook "${antes?.nome || id}" (${antes?.funcionalidade_nome || '?'} / `
                    + `${antes?.gatilho_nome || `gatilho ${antes?.gatilho}`}) apagado do CV por ${quem(req)}.`,
            stats: { acao: 'apagar_webhook_cv', idwebhook: id, apagado: antes },
        });

        return res.json({ ok: true, idwebhook: id });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

/**
 * POST /api/cv-integracoes/webhooks/:id/padronizar-nome
 *
 * Renomear exige apagar e criar de novo (a API do CV não tem PUT). O
 * `recriarWebhook` cria antes de apagar, então uma falha deixa o webhook
 * antigo de pé em vez de deixar a integração sem nenhum.
 */
export async function padronizarNome(req, res) {
    try {
        const id = Number(req.params.id);
        const atual = (await listarWebhooks(baseDoOffice())).find(w => w.idwebhook === id);
        if (!atual) return res.status(404).json({ error: 'Webhook não encontrado no CV.' });
        if (!atual.nome_padrao) {
            return res.status(400).json({ error: 'Sem o nome do gatilho no catálogo do CV, não dá para montar o nome padrão.' });
        }
        if (atual.nome === atual.nome_padrao) {
            return res.status(400).json({ error: 'Este webhook já está no padrão.' });
        }

        const novo = await recriarWebhook(id, {
            nome: atual.nome_padrao,
            funcionalidade: atual.funcionalidade,
            endereco: atual.endereco,
            gatilho: atual.gatilho,
            ativo: atual.ativo,
            idempreendimento: atual.empreendimentos.map(e => e.id),
        });

        await registrar({
            origem: 'manual',
            funcionalidade: CV_PARA_LOCAL[atual.funcionalidade] || 'cv',
            status: 'ok',
            mensagem: `Webhook "${atual.nome}" renomeado para "${novo.nome}" por ${quem(req)} `
                    + `(recriado: id ${id} virou ${novo.idwebhook}).`,
            stats: { acao: 'padronizar_nome', de: id, para: novo.idwebhook, antes: atual },
        });

        return res.json({ ok: true, webhook: novo });
    } catch (err) {
        await registrar({
            origem: 'manual', funcionalidade: 'cv', status: 'erro',
            mensagem: `Falha ao padronizar nome do webhook ${req.params.id} (${quem(req)}): ${err.message}`,
        });
        return res.status(502).json({ error: err.message });
    }
}

/**
 * POST /api/cv-integracoes/webhooks/:id/alternar-ativo
 *
 * Ligar e desligar um webhook no CV também passa por recriar - a API não tem
 * PUT, então não existe "só mudar o ativoPainel". O id muda, e a tela avisa.
 *
 * Existe porque a alternativa era pior: sem isto, o único jeito de ativar um
 * webhook criado desligado seria apagar e cadastrar de novo à mão, com o risco
 * de errar o endereço ou o gatilho no caminho.
 */
export async function alternarAtivo(req, res) {
    try {
        const id = Number(req.params.id);
        const atual = (await listarWebhooks(baseDoOffice())).find(w => w.idwebhook === id);
        if (!atual) return res.status(404).json({ error: 'Webhook não encontrado no CV.' });

        const novo = await recriarWebhook(id, {
            nome: atual.nome,
            funcionalidade: atual.funcionalidade,
            endereco: atual.endereco,
            gatilho: atual.gatilho,
            ativo: !atual.ativo,
            idempreendimento: atual.empreendimentos.map(e => e.id),
        });

        await registrar({
            origem: 'manual',
            funcionalidade: CV_PARA_LOCAL[atual.funcionalidade] || 'cv',
            status: 'ok',
            mensagem: `Webhook "${atual.nome}" ${atual.ativo ? 'DESATIVADO' : 'ATIVADO'} no CV por ${quem(req)} `
                    + `(recriado: id ${id} virou ${novo.idwebhook}).`,
            stats: { acao: 'alternar_ativo', de: id, para: novo.idwebhook, ativo: !atual.ativo },
        });

        return res.json({ ok: true, webhook: novo });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}

export default { listar, gatilhos, criar, apagar, padronizarNome, alternarAtivo };
