// services/OfficeAI/embeddingIndex.js
//
// Índice de embeddings da Eme: acha por SIMILARIDADE o que antes era achado
// por regex e palavra-chave - a tool certa para a pergunta, o bloco de regra
// que fala do assunto, o termo do glossário que a pessoa acabou de usar.
//
// Como funciona:
//   - ensureEmbeddings(kind, itens) devolve um Map key → vetor. Item cujo
//     texto mudou (hash diferente) é re-embedado; item novo é embedado; o resto
//     vem do cache em memória ou de eme_embeddings. Há um teto de embeddings
//     novos por chamada (maxNew) para um turno nunca esperar a indexação
//     inteira: o que não coube fica para o turno seguinte, e quem não tem
//     vetor ainda simplesmente não pontua por similaridade.
//   - embedQuery(texto) embeda a pergunta (cache de 30 min por texto
//     normalizado, igual ao academyRetrievalService).
//   - rank(consulta, mapa) ordena por cosseno.
//
// Tudo degrada com graça: sem chave Gemini, sem tabela ou com a API fora,
// devolve vazio/null e quem chama segue pelo caminho antigo.
import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import { embedText, EMBEDDING_MODEL } from './geminiClient.js';

const mem = new Map();          // `${kind}` → Map(key → { hash, vec })
const loaded = new Set();       // kinds já carregados do banco
const queryCache = new Map();   // texto normalizado → { vec, exp }
const QUERY_TTL = 30 * 60 * 1000;
const QUERY_CAP = 500;
let pendente = null;            // Promise da indexação em andamento (evita duas ao mesmo tempo)

export function hashText(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

export function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normQuery(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

async function loadKind(kind) {
    if (loaded.has(kind)) return mem.get(kind);
    const map = new Map();
    try {
        const rows = await db.EmeEmbedding.findAll({ where: { kind }, attributes: ['ref_key', 'content_hash', 'vector'], raw: true });
        for (const r of rows) if (Array.isArray(r.vector)) map.set(r.ref_key, { hash: r.content_hash, vec: r.vector });
    } catch (err) {
        console.warn('[embeddingIndex] não carregou', kind, err?.message);
    }
    mem.set(kind, map);
    loaded.add(kind);
    return map;
}

/**
 * @param {string} kind  tool | block | glossary
 * @param {Array<{key:string, text:string}>} items
 * @param {{maxNew?:number}} opts  teto de embeddings novos nesta chamada
 * @returns {Promise<Map<string, number[]>>} key → vetor (só quem já tem)
 */
export async function ensureEmbeddings(kind, items = [], { maxNew = 20 } = {}) {
    const map = await loadKind(kind);
    const out = new Map();
    const faltam = [];
    for (const it of items) {
        if (!it?.key) continue;
        const hash = hashText(it.text);
        const atual = map.get(it.key);
        if (atual && atual.hash === hash) out.set(it.key, atual.vec);
        else faltam.push({ ...it, hash });
    }
    if (faltam.length && maxNew > 0) {
        // Uma indexação por vez: dois turnos simultâneos não devem embedar o
        // mesmo item duas vezes.
        if (!pendente) {
            pendente = indexar(kind, map, faltam.slice(0, maxNew)).finally(() => { pendente = null; });
        }
        await pendente;
        for (const it of faltam) {
            const v = map.get(it.key);
            if (v && v.hash === it.hash) out.set(it.key, v.vec);
        }
    }
    return out;
}

async function indexar(kind, map, itens) {
    for (const it of itens) {
        const vec = await embedText(it.text, { taskType: 'RETRIEVAL_DOCUMENT' });
        if (!vec) continue;    // sem chave/API fora: tenta de novo no próximo turno
        map.set(it.key, { hash: it.hash, vec });
        try {
            await db.EmeEmbedding.upsert({
                kind, ref_key: it.key, content_hash: it.hash, model: EMBEDDING_MODEL, dims: vec.length, vector: vec,
            });
        } catch (err) {
            console.warn('[embeddingIndex] upsert falhou', kind, it.key, err?.message);
        }
    }
}

/** Embedding da pergunta, com cache. null quando não dá (sem chave, API fora). */
export async function embedQuery(text) {
    const key = normQuery(text);
    if (!key) return null;
    const hit = queryCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.vec;
    const vec = await embedText(text, { taskType: 'RETRIEVAL_QUERY' });
    if (vec) {
        if (queryCache.size >= QUERY_CAP) queryCache.clear();
        queryCache.set(key, { vec, exp: Date.now() + QUERY_TTL });
    }
    return vec;
}

/** [{ key, sim }] do mais parecido ao menos. */
export function rank(queryVec, vectors) {
    if (!queryVec || !vectors?.size) return [];
    const out = [];
    for (const [key, vec] of vectors) out.push({ key, sim: cosine(queryVec, vec) });
    return out.sort((a, b) => b.sim - a.sim);
}

/** Quantos itens de cada tipo estão indexados (para a tela). */
export async function indexStatus() {
    try {
        const rows = await db.EmeEmbedding.findAll({
            attributes: ['kind', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n'], [db.sequelize.fn('MAX', db.sequelize.col('updated_at')), 'ultimo']],
            group: ['kind'], raw: true,
        });
        return Object.fromEntries(rows.map(r => [r.kind, { total: Number(r.n), ultimo: r.ultimo }]));
    } catch { return {}; }
}

/** Apaga o índice de um tipo (ou todos); o próximo turno reindexa. */
export async function resetIndex(kind = null) {
    await db.EmeEmbedding.destroy({ where: kind ? { kind } : {} });
    if (kind) { mem.delete(kind); loaded.delete(kind); }
    else { mem.clear(); loaded.clear(); }
    queryCache.clear();
}

export default { ensureEmbeddings, embedQuery, rank, cosine, hashText, indexStatus, resetIndex };
