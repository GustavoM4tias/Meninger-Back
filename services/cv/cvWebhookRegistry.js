// services/cv/cvWebhookRegistry.js
//
// O lado do CV: quais webhooks estão cadastrados lá, quais gatilhos existem, e
// como criar e apagar.
//
// Três coisas medidas na API em 28/08/2026 que moldam este módulo:
//
//   1. NÃO EXISTE PUT/PATCH. Editar um webhook é apagar e criar de novo. Por
//      isso `recriar()` existe como operação nomeada, com a ordem invertida do
//      óbvio: cria o novo ANTES de apagar o velho. Se a criação falhar, o
//      antigo continua de pé e nada se perde - o contrário deixaria a
//      integração morta no meio do caminho.
//
//   2. `forma_envio` não é parâmetro de criação. Os webhooks do Office estão
//      em "id" e os de terceiros em "body". Como não dá para escolher, o
//      handler do Office lê o id de várias formas possíveis (ver
//      cvWebhookService.extrairId) em vez de depender de um formato.
//
//   3. O gatilho -2 ("Alteração de situação") existe para Reserva, Repasse,
//      Pré-cadastro e Lead. É o gatilho que cobre qualquer mudança de etapa
//      com um cadastro só - os gatilhos positivos são um por situação.

import apiCv from '../../lib/apiCv.js';

// Códigos que a API usa. Só os que fazem sentido para o Office ganham rótulo
// próprio; o resto aparece com o código mesmo, sem inventar tradução.
export const FUNCIONALIDADES_CV = {
    RS: 'Reservas',
    RP: 'Repasse',
    PR: 'Pré-cadastros',
    LD: 'Leads',
    UN: 'Unidades',
    CL: 'Cliente',
    CR: 'Corretor',
    CM: 'Comissão',
    PC: 'Pagamento de Comissão',
    CV: 'Contrato de Venda',
    CI: 'Contrato por Imobiliária',
    EC: 'Envio de Comissão',
    EV: 'Espelho de Vendas',
    AT: 'Atendimento',
    AS: 'Assistência',
    AG: 'Agendamento',
    TP: 'Tabela de Preço',
    PS: 'Pesquisas',
};

/** Mapa código do CV -> funcionalidade do endpoint local, quando existe. */
export const CV_PARA_LOCAL = { RS: 'reservas', RP: 'repasses', LD: 'leads', PR: 'precadastros' };

// ── Padrão de nome ───────────────────────────────────────────────────────────
//
// Os webhooks nasceram com nomes de épocas diferentes ("CONTRATOS_IA",
// "cancelamento-reservas", "Boleto Ato "). Com seis cadastros ainda dá para
// adivinhar; com vinte, não. O padrão responde três perguntas no próprio nome:
// de quem é, sobre o quê, e disparado por quê.
//
//     office-<funcionalidade>-<gatilho>
//
// Nome fora do padrão não é erro e não é corrigido sozinho: renomear exige
// apagar e recriar (ver acima), e fazer isso por conta própria num webhook
// vivo é o tipo de iniciativa que derruba integração.

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

export function apelidoDoGatilho(nomeGatilho) {
    return semAcento(nomeGatilho)
        .toLowerCase()
        .replace(/^quando entrar na situacao\s+/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

export function nomePadrao(funcionalidade, nomeGatilho) {
    const func = semAcento(FUNCIONALIDADES_CV[funcionalidade] || funcionalidade)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `office-${func}-${apelidoDoGatilho(nomeGatilho)}`;
}

// ── Leitura ──────────────────────────────────────────────────────────────────

/** Catálogo de gatilhos por funcionalidade, direto do CV. */
export async function listarGatilhos() {
    const { data } = await apiCv.get('/v1/integracoes/webhooks/gatilhos');
    return (data?.dados || []).map(f => ({
        funcionalidade: f.funcionalidade,
        nome: f.nome || FUNCIONALIDADES_CV[f.funcionalidade] || f.funcionalidade,
        gatilhos: (f.gatilhos || []).map(g => ({ gatilho: g.gatilho, nome: g.nome })),
    }));
}

/**
 * Todos os webhooks cadastrados no CV, enriquecidos com o que o Office sabe:
 * o nome legível do gatilho, se o destino é o próprio Office, e se o nome
 * segue o padrão.
 *
 * @param {string} baseDoOffice URL pública do backend, para reconhecer o destino
 */
export async function listarWebhooks(baseDoOffice = '') {
    const [{ data }, catalogo] = await Promise.all([
        apiCv.get('/v1/integracoes/webhooks', { params: { limitePagina: 500 } }),
        listarGatilhos().catch(() => []),
    ]);

    const nomeDoGatilho = new Map();
    for (const f of catalogo) {
        for (const g of f.gatilhos) nomeDoGatilho.set(`${f.funcionalidade}:${g.gatilho}`, g.nome);
    }

    const base = String(baseDoOffice || '').replace(/\/+$/, '');

    return (data?.dados || []).map(w => {
        const gatilhoNome = nomeDoGatilho.get(`${w.funcionalidade}:${w.gatilho}`) || null;
        // ativoPainel volta como boolean numas linhas e string "true" noutras.
        const ativo = w.ativoPainel === true || String(w.ativoPainel).toLowerCase() === 'true';
        return {
            idwebhook: w.idwebhook,
            nome: w.nome ? String(w.nome).trim() : '',
            funcionalidade: w.funcionalidade,
            funcionalidade_nome: FUNCIONALIDADES_CV[w.funcionalidade] || w.funcionalidade,
            gatilho: w.gatilho,
            gatilho_nome: gatilhoNome,
            endereco: w.endereco,
            ativo,
            forma_envio: w.forma_envio || null,
            data_cadastro: w.dataCad || null,
            empreendimentos: (w.empreendimentos || []).map(e => ({ id: e.idempreendimento, nome: e.nome })),
            // Destino: o que aponta para o Office é nosso e tem um endpoint
            // local correspondente; o resto é integração de terceiro e a tela
            // precisa deixar isso claro antes de alguém apagar por engano.
            do_office: !!base && String(w.endereco || '').startsWith(base),
            nome_padrao: gatilhoNome ? nomePadrao(w.funcionalidade, gatilhoNome) : null,
            fora_do_padrao: !!gatilhoNome
                && !!base && String(w.endereco || '').startsWith(base)
                && String(w.nome || '').trim() !== nomePadrao(w.funcionalidade, gatilhoNome),
        };
    });
}

// ── Escrita ──────────────────────────────────────────────────────────────────

/**
 * Cria um webhook no CV.
 * `idempreendimento` vazio significa TODOS os empreendimentos - é o que se quer
 * para um webhook de dados, e o contrário do que os webhooks de automação usam
 * (o de cancelamento tem 19 empreendimentos escolhidos a dedo).
 */
export async function criarWebhook({ nome, funcionalidade, endereco, gatilho, ativo = true, idempreendimento }) {
    const corpo = {
        nome: String(nome || '').trim(),
        funcionalidade: String(funcionalidade || '').trim().toUpperCase(),
        endereco: String(endereco || '').trim(),
        gatilho: Number(gatilho),
        ativoPainel: !!ativo,
    };
    if (Array.isArray(idempreendimento) && idempreendimento.length) {
        corpo.idempreendimento = idempreendimento.map(Number).filter(Number.isFinite);
    }

    if (!corpo.nome) throw new Error('O webhook precisa de um nome.');
    if (!corpo.funcionalidade) throw new Error('Escolha a funcionalidade.');
    if (!/^https?:\/\//i.test(corpo.endereco)) throw new Error('O endereço precisa ser uma URL http(s).');
    if (!Number.isFinite(corpo.gatilho)) throw new Error('Escolha o gatilho.');

    const { data } = await apiCv.post('/v1/integracoes/webhooks', corpo);
    // O CV tem histórico de responder erro em corpo com status 2xx (é o caso
    // conhecido do POST de correspondentes), então a resposta é conferida em
    // vez de assumida.
    const id = data?.data?.id;
    if (!id) throw new Error(`O CV aceitou a chamada mas não devolveu o id do webhook: ${JSON.stringify(data).slice(0, 300)}`);
    return { idwebhook: id, ...corpo };
}

/** Apaga um webhook no CV. */
export async function apagarWebhook(idwebhook) {
    const id = Number(idwebhook);
    if (!Number.isFinite(id)) throw new Error('Id de webhook inválido.');
    const { data } = await apiCv.delete(`/v1/integracoes/webhooks/${id}`);
    return { idwebhook: id, resposta: data };
}

/**
 * Substitui um webhook, que é a única forma de "editar" nesta API.
 *
 * Cria o novo ANTES de apagar o antigo de propósito: se a criação falhar, o
 * antigo segue funcionando e o erro é só um erro. Na ordem inversa, uma falha
 * no meio deixaria a integração sem webhook nenhum - e ninguém perceberia até
 * o dado parar de chegar.
 */
export async function recriarWebhook(idAntigo, novo) {
    const criado = await criarWebhook(novo);
    try {
        await apagarWebhook(idAntigo);
    } catch (err) {
        throw new Error(
            `O webhook novo foi criado (id ${criado.idwebhook}), mas o antigo (id ${idAntigo}) não pôde ser apagado: `
            + `${err.message}. Os dois estão ativos agora - apague o antigo pela tela.`,
        );
    }
    return criado;
}

export default {
    FUNCIONALIDADES_CV,
    CV_PARA_LOCAL,
    nomePadrao,
    listarGatilhos,
    listarWebhooks,
    criarWebhook,
    apagarWebhook,
    recriarWebhook,
};
