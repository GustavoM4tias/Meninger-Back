// services/ai/providers.js
//
// Leitura e escrita das conexões de IA. É a fonte única de "qual fornecedor,
// com qual chave, com quais modelos, atendendo qual contexto".
//
// ─────────────────────────────────────────────────────────────────────────────
// A REGRA QUE NÃO SE NEGOCIA: A CHAVE ESCREVE, NUNCA VOLTA
//
// `paraTela()` devolve quantas chaves existem e os últimos caracteres de cada
// uma - o bastante para a pessoa reconhecer qual cadastrou, e nada além.
// Credencial que a API devolve é credencial que vaza no cache do navegador, no
// log do proxy e no print de tela que alguém manda no grupo.
//
// `chavesDe()` é o ÚNICO caminho que decifra, e só o gateway chama.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ENV COMO PISO, NÃO COMO REGRA
//
// Enquanto ninguém cadastrar chave na tela, o provedor Gemini continua usando
// `GEMINI_API_KEYS`. Migrar segredo sem alguém pedir seria mexer em credencial
// por conta própria; e o dia em que a tela assume, a env vira reserva de
// quando o banco não responde.

import db from '../../models/sequelize/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

/** Os adaptadores que existem. `openai` cobre qualquer API compatível. */
export const TIPOS = ['gemini', 'openai', 'anthropic'];

/** Os usos que um pool de modelos pode ter. */
export const USOS = ['chat', 'json', 'visao', 'embed'];

/** Contextos do produto que podem ser roteados. */
export const CONTEXTOS = ['office_chat', 'relatorios', 'eme_atende', 'validador', 'utilidades', 'academy', 'processos'];

/**
 * QUEM JÁ PASSA PELA PORTA ÚNICA - e quem ainda não.
 *
 * A migração é por contexto, de propósito: virar a chave do sistema inteiro de
 * uma vez é como se descobre, em produção, que um formato não era equivalente.
 * Mas tela que oferece um botão inerte é pior que tela que não oferece nada, e
 * é exatamente o que aconteceria se todos os contextos aparecessem iguais:
 * o admin trocaria o fornecedor do chat, nada mudaria, e ele passaria a
 * desconfiar da tela toda - inclusive das partes que funcionam.
 *
 * Então aqui fica escrito o que vale HOJE. `roteavel: false` sai na tela como
 * "ainda no caminho nativo", com o motivo, e o campo de provedor vem travado.
 */
export const SUPORTE = {
    utilidades: { roteavel: true },
    academy: { roteavel: true },
    // Nasceu já na porta única: o motor de processos é posterior a ela.
    processos: { roteavel: true },
    office_chat: { roteavel: true },
    relatorios: { roteavel: true },
    eme_atende: {
        roteavel: false,
        motivo: 'Mantido no caminho atual por decisão de produto.',
    },
    validador: {
        roteavel: false,
        motivo: 'O Validador tem sonda de saúde, rotação de chave e pool de modelos próprios (tela /validator > Saúde), e transcreve ÁUDIO - capacidade que nem todo fornecedor tem. Migrar exige um passe dedicado.',
    },
};

const TTL = 30 * 1000;
let _cache = null;
let _cacheAt = 0;

export function invalidateProvidersCache() { _cache = null; _cacheAt = 0; }

/**
 * Há algum provedor habilitado? SÍNCRONO, e por isso best-effort.
 *
 * Existe para os gates de "vale a pena tentar?" que já eram síncronos no
 * código antigo (`if (hasGeminiKey() && ...)`). Sem o cache carregado responde
 * SIM: tentar uma vez e receber null é muito melhor que pular silenciosamente
 * um digest que daria certo.
 */
export function temProvedorSync() {
    if (_cache) return _cache.providers.some(p => p.enabled);
    return true;
}

// ── Leitura ──────────────────────────────────────────────────────────────────

async function carregar() {
    if (_cache && Date.now() - _cacheAt < TTL) return _cache;
    const [providers, routes] = await Promise.all([
        db.AiProvider.findAll({ order: [['ordem', 'ASC'], ['id', 'ASC']], raw: true }),
        db.AiRoute.findAll({ raw: true }),
    ]);
    _cache = { providers, routes };
    _cacheAt = Date.now();
    return _cache;
}

/**
 * As chaves EM CLARO de um provedor. Único caminho que decifra.
 *
 * Chave que não decifra é PULADA em vez de derrubar a chamada: o JWT_SECRET
 * pode ter mudado, e nesse caso o certo é seguir com as que ainda funcionam e
 * deixar o erro aparecer na checagem - não parar a operação inteira.
 */
export function chavesDe(provider) {
    const cifradas = Array.isArray(provider?.api_keys_enc) ? provider.api_keys_enc : [];
    const out = [];
    for (const c of cifradas) {
        try {
            const clara = decrypt(c);
            if (clara) out.push(clara);
        } catch (err) {
            console.warn('[ai/providers] chave não decifrou (JWT_SECRET mudou?):', err?.message);
        }
    }
    // Piso: enquanto a tela não tiver chave, o Gemini segue com a env - é o que
    // está valendo em produção hoje, e trocar isso sem alguém pedir seria mexer
    // em credencial por conta própria.
    if (!out.length && provider?.kind === 'gemini') {
        const env = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
            .split(/[,;\n\r]+/).map(k => k.trim()).filter(Boolean);
        return env;
    }
    return out;
}

/** Quantas chaves e como reconhecê-las, sem entregar nenhuma. */
export function resumoDeChaves(provider) {
    const claras = chavesDe(provider);
    return {
        total: claras.length,
        // Só o suficiente para a pessoa saber QUAL chave está ali.
        finais: claras.map(k => `****${String(k).slice(-4)}`),
        vem_da_env: !((provider?.api_keys_enc || []).length) && claras.length > 0,
    };
}

/** O provedor de um contexto, com o pool já resolvido. */
export async function provedorDe(contexto) {
    const { providers, routes } = await carregar();
    const rota = routes.find(r => r.contexto === contexto) || null;

    if (rota && rota.enabled === false) {
        return { erro: `O contexto "${rota.label || contexto}" está pausado na tela de Conexões de IA.`, pausado: true, rota };
    }

    const habilitados = providers.filter(p => p.enabled);
    const provider = (rota?.provider_key && habilitados.find(p => p.key === rota.provider_key))
        || habilitados[0]
        || null;

    if (!provider) return { erro: 'Nenhum provedor de IA habilitado. Cadastre um em Configurações > Conexões de IA.' };

    // Override do contexto tem prioridade sobre o pool do fornecedor: é o que
    // permite o mesmo Gemini servir o chat com o pro e a extração com o flash.
    const models = {};
    for (const uso of USOS) {
        const doContexto = rota?.models?.[uso];
        const doProvedor = provider.models?.[uso];
        models[uso] = (Array.isArray(doContexto) && doContexto.length) ? doContexto
            : (Array.isArray(doProvedor) ? doProvedor : []);
    }

    return { provider, rota, models };
}

/** Tudo o que a tela precisa - sem nenhuma credencial. */
export async function paraTela() {
    const { providers, routes } = await carregar();
    return {
        providers: providers.map(p => ({
            id: p.id, key: p.key, label: p.label, kind: p.kind,
            base_url: p.base_url, models: p.models, capabilities: p.capabilities,
            extra: p.extra, enabled: p.enabled, ordem: p.ordem,
            status: p.status, status_since: p.status_since,
            last_check_at: p.last_check_at, last_error: p.last_error, last_models: p.last_models,
            chaves: resumoDeChaves(p),
        })),
        // A rota carrega o que a tela precisa para NÃO prometer o que ainda
        // não entrega: contexto não roteável vem travado e com o motivo.
        routes: routes.map(r => ({ ...r, ...(SUPORTE[r.contexto] || { roteavel: false }) })),
        tipos: TIPOS,
        usos: USOS,
    };
}

// ── Escrita ──────────────────────────────────────────────────────────────────

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function listaDeModelos(v) {
    const bruta = Array.isArray(v) ? v : String(v || '').split(/[\n,]+/);
    return [...new Set(bruta.map(m => String(m).trim()).filter(Boolean))]
        .filter(m => /^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{1,120}$/.test(m))
        .slice(0, 8);
}

/**
 * Valida o que a tela manda. Erros aqui LANÇAM com `.expose = 400`: provedor
 * salvo pela metade é pior que a gravação recusada, porque o defeito só
 * aparece na próxima pergunta de alguém.
 */
export function sanitizeProvider(patch = {}, { novo = false } = {}) {
    const out = {};
    const erro = (msg) => { const e = new Error(msg); e.expose = 400; throw e; };

    if (novo || patch.key !== undefined) {
        const key = str(patch.key, 40).toLowerCase();
        if (!/^[a-z][a-z0-9_-]{1,39}$/.test(key)) erro('Identificador inválido. Use letras minúsculas, números, hífen ou sublinhado.');
        out.key = key;
    }
    if (novo || patch.label !== undefined) {
        const label = str(patch.label, 120);
        if (!label) erro('Dê um nome ao provedor.');
        out.label = label;
    }
    if (novo || patch.kind !== undefined) {
        if (!TIPOS.includes(patch.kind)) erro(`Tipo inválido. Use: ${TIPOS.join(', ')}.`);
        out.kind = patch.kind;
    }
    if (patch.base_url !== undefined) {
        const url = str(patch.base_url, 300);
        if (url && !/^https?:\/\//i.test(url)) erro('O endereço precisa começar com http:// ou https://.');
        out.base_url = url || null;
    }
    if (patch.models !== undefined) {
        const models = {};
        for (const uso of USOS) models[uso] = listaDeModelos(patch.models?.[uso]);
        out.models = models;
    }
    if (patch.capabilities !== undefined && patch.capabilities && typeof patch.capabilities === 'object') {
        out.capabilities = Object.fromEntries(
            ['chat', 'tools', 'json', 'visao', 'embed', 'stream'].map(c => [c, !!patch.capabilities[c]]));
    }
    if (patch.extra !== undefined) {
        out.extra = (patch.extra && typeof patch.extra === 'object' && !Array.isArray(patch.extra)) ? patch.extra : {};
    }
    if (patch.enabled !== undefined) out.enabled = !!patch.enabled;
    if (patch.ordem !== undefined) {
        const n = Number(patch.ordem);
        out.ordem = Number.isFinite(n) ? Math.min(999, Math.max(0, Math.round(n))) : 0;
    }
    return out;
}

/**
 * Grava as chaves. `api_keys` vem da tela em CLARO e sai daqui cifrada.
 *
 * Lista vazia APAGA as chaves; `undefined` deixa como está. A diferença
 * importa: salvar o formulário sem mexer no campo de chave não pode desconectar
 * o provedor, e é exatamente o que aconteceria se vazio significasse apagar.
 */
export function cifrarChaves(api_keys) {
    if (api_keys === undefined) return undefined;
    const lista = (Array.isArray(api_keys) ? api_keys : String(api_keys || '').split(/[,;\n\r]+/))
        .map(k => String(k).trim())
        .filter(Boolean)
        .slice(0, 10);
    return lista.map(k => encrypt(k)).filter(Boolean);
}

export async function salvarProvider(id, body = {}, userId = null) {
    const novo = !id;
    const patch = sanitizeProvider(body, { novo });
    const chaves = cifrarChaves(body.api_keys);
    if (chaves !== undefined) patch.api_keys_enc = chaves;
    if (userId) patch.updated_by = userId;

    let row;
    if (novo) {
        const jaExiste = await db.AiProvider.findOne({ where: { key: patch.key } });
        if (jaExiste) { const e = new Error('Já existe um provedor com este identificador.'); e.expose = 400; throw e; }
        row = await db.AiProvider.create(patch);
    } else {
        row = await db.AiProvider.findByPk(id);
        if (!row) { const e = new Error('Provedor não encontrado.'); e.expose = 404; throw e; }
        await row.update(patch);
    }
    invalidateProvidersCache();
    return row;
}

export async function removerProvider(id) {
    const row = await db.AiProvider.findByPk(id);
    if (!row) { const e = new Error('Provedor não encontrado.'); e.expose = 404; throw e; }

    // Provedor em uso não some sem aviso: a rota ficaria apontando para o nada
    // e o contexto cairia no padrão sem ninguém entender por quê.
    const emUso = await db.AiRoute.findAll({ where: { provider_key: row.key }, raw: true });
    if (emUso.length) {
        const e = new Error(`Este provedor atende ${emUso.length} contexto(s): ${emUso.map(r => r.label).join(', ')}. Aponte-os para outro antes de remover.`);
        e.expose = 400;
        throw e;
    }

    await row.destroy();
    invalidateProvidersCache();
}

export async function salvarRota(contexto, body = {}, userId = null) {
    if (!CONTEXTOS.includes(contexto)) { const e = new Error('Contexto desconhecido.'); e.expose = 400; throw e; }
    const row = await db.AiRoute.findByPk(contexto);
    if (!row) { const e = new Error('Contexto não encontrado.'); e.expose = 404; throw e; }

    // A trava é do SERVIDOR, não da tela: campo desabilitado no navegador é
    // aparência, e uma troca aceita aqui viraria uma configuração gravada que
    // nenhum código lê - o pior tipo de defeito, o que não dá erro.
    const suporte = SUPORTE[contexto] || { roteavel: false };
    if (!suporte.roteavel && (body.provider_key !== undefined || body.models !== undefined)) {
        const e = new Error(`O contexto "${row.label}" ainda não passa pela porta única, então trocar o provedor aqui não teria efeito. ${suporte.motivo || ''}`.trim());
        e.expose = 400;
        throw e;
    }

    const patch = {};
    if (body.provider_key !== undefined) {
        const key = str(body.provider_key, 40) || null;
        if (key) {
            const existe = await db.AiProvider.findOne({ where: { key }, raw: true });
            if (!existe) { const e = new Error('Provedor não encontrado.'); e.expose = 400; throw e; }
        }
        patch.provider_key = key;
    }
    if (body.models !== undefined) {
        const models = {};
        for (const uso of USOS) {
            const l = listaDeModelos(body.models?.[uso]);
            if (l.length) models[uso] = l;
        }
        patch.models = models;
    }
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (userId) patch.updated_by = userId;

    await row.update(patch);
    invalidateProvidersCache();
    return row;
}

/** Estado da checagem - escrito pelo gateway, não pela tela. */
export async function registrarChecagem(id, { status, erro = null, modelos = [] }) {
    try {
        const row = await db.AiProvider.findByPk(id);
        if (!row) return;
        const agora = new Date();
        const patch = { status, last_check_at: agora, last_error: erro, last_models: modelos };
        if (row.status !== status) patch.status_since = agora;
        await row.update(patch);
        invalidateProvidersCache();
    } catch (err) {
        console.warn('[ai/providers] checagem não registrada:', err?.message);
    }
}

export default {
    provedorDe, paraTela, chavesDe, resumoDeChaves, SUPORTE,
    salvarProvider, removerProvider, salvarRota, registrarChecagem,
    sanitizeProvider, cifrarChaves, invalidateProvidersCache,
    TIPOS, USOS, CONTEXTOS,
};
