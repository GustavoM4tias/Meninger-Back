// services/academy/academyRetrievalService.js
//
// Recuperação de PROCESSOS para a Eme. Núcleo da economia de tokens:
//   - searchProcesses: híbrido (vetorial pgvector + keyword), filtrado por
//     audience + departamento, devolve DIGESTS (curtos) — não o corpo.
//   - getProcess: corpo/seção sob demanda (truncado).
//   - processRequirements: grafo (processFor/prerequisites) p/ "o que preciso
//     para a ação X".
// Cache: embedding da query (global) + resultado de busca (por usuário, TTL).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { resolveUserTokens, audiencesWhereLiteral } from './audience.js';
import { departmentWhereForUser } from './departmentVisibility.js';
import { embedText, toPgVector } from '../OfficeAI/geminiClient.js';

// ── Caches in-memory (bounded + TTL) ───────────────────────────────────────
const EMB_TTL = 30 * 60 * 1000;     // embedding de query: 30 min
const SEARCH_TTL = 10 * 60 * 1000;  // resultado de busca: 10 min
const CAP = 500;
const embCache = new Map();    // normQuery → { emb, exp }
const searchCache = new Map(); // `${userId}::${normQuery}::...` → { data, exp }

function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
function cacheGet(map, key) {
    const v = map.get(key);
    if (!v) return null;
    if (Date.now() > v.exp) { map.delete(key); return null; }
    return v;
}
function cacheSet(map, key, val, ttl) {
    if (map.size >= CAP) map.clear(); // simples: esvazia ao estourar
    map.set(key, { ...val, exp: Date.now() + ttl });
}

// Stopwords PT p/ tokenizar a pergunta — uma pergunta em linguagem natural
// ("como fazer uma reserva no cvcrm") não bate como substring única; precisa
// casar pelos TERMOS relevantes (reserva, cvcrm). Mantém acentos (ILIKE é
// case-insensitive mas acento-sensitive).
const STOPWORDS = new Set([
    'como', 'fazer', 'faz', 'faço', 'um', 'uma', 'uns', 'umas', 'o', 'a', 'os', 'as',
    'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'em', 'para', 'pra',
    'por', 'que', 'qual', 'quais', 'e', 'ou', 'com', 'sem', 'ao', 'aos', 'meu', 'minha',
    'meus', 'minhas', 'quero', 'preciso', 'sobre', 'ser', 'tem', 'ter', 'são', 'sao',
    'onde', 'quando', 'isso', 'esse', 'essa', 'esta', 'este', 'aqui', 'lá', 'la', 'me',
    'se', 'já', 'ja', 'vou', 'pode', 'posso', 'qual', 'the', 'of', 'to',
]);
function tokenizeQuery(q) {
    const words = String(q || '').toLowerCase()
        .split(/[\s\-_/.,;:!?()"'’]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    const uniq = [...new Set(words)].slice(0, 8);
    if (uniq.length) return uniq;
    // tudo virou stopword → usa a query inteira (sem pontuação) como 1 termo
    const whole = String(q || '').toLowerCase().replace(/[^a-zà-ÿ0-9 ]/gi, '').trim();
    return whole ? [whole] : [];
}

// Extrai URLs de vídeo (YouTube) do payload do artigo (embeds VIDEO). É o que
// evita a Eme INVENTAR link de vídeo: a URL real vem daqui para o resultado.
function videoUrlsFromPayload(payload) {
    const embeds = Array.isArray(payload?.embeds) ? payload.embeds : [];
    return embeds
        .filter((e) => String(e?.type || '').toUpperCase() === 'VIDEO')
        .map((e) => e.url || (e.ref ? `https://youtu.be/${e.ref}` : null))
        .filter(Boolean);
}

let _embAvail = { val: false, exp: 0 };

const academyRetrievalService = {
    // pgvector disponível E há ao menos 1 artigo com embedding? (cacheado 5min)
    async _hasEmbeddings() {
        if (Date.now() < _embAvail.exp) return _embAvail.val;
        let val = false;
        try {
            const [rows] = await db.sequelize.query(
                `SELECT 1 FROM academy_articles WHERE embedding IS NOT NULL LIMIT 1`
            );
            val = Array.isArray(rows) ? rows.length > 0 : false;
        } catch { val = false; }
        _embAvail = { val, exp: Date.now() + 5 * 60 * 1000 };
        return val;
    },

    async _queryEmbedding(q) {
        const key = norm(q);
        const hit = cacheGet(embCache, key);
        if (hit) return hit.emb;
        const emb = await embedText(q, { taskType: 'RETRIEVAL_QUERY' });
        if (emb) cacheSet(embCache, key, { emb }, EMB_TTL);
        return emb;
    },

    _toDigestResult(r) {
        const d = r.aiDigest || {};
        const pm = r.processMeta || {};
        const pick = (a, b) => (Array.isArray(a) && a.length ? a : (Array.isArray(b) ? b : []));
        return {
            title: r.title,
            slug: r.slug,
            category: r.categorySlug,
            subcategory: r.subcategorySlug || null,
            link: `/academy/kb/${encodeURIComponent(r.categorySlug)}/${encodeURIComponent(r.slug)}`,
            resumo: d.resumo || null,
            processFor: pick(pm.processFor, d.processFor),
            prerequisites: pick(pm.prerequisites, d.prerequisites),
            systems: Array.isArray(d.systems) ? d.systems : [],
            videoUrl: videoUrlsFromPayload(r.payload)[0] || null, // URL REAL do vídeo
            hasDigest: !!d.resumo,
        };
    },

    /**
     * Busca processos (digests). Híbrido vetorial+keyword, filtrado por
     * audience+departamento. Devolve resumos curtos, NÃO o corpo.
     */
    async searchProcesses({ query, userId, k = 6, categorySlug = null }) {
        const q = String(query || '').trim();
        const cacheKey = `${userId}::${norm(q)}::${categorySlug || ''}::${k}`;
        const cached = cacheGet(searchCache, cacheKey);
        if (cached) return cached.data;

        const tokens = await resolveUserTokens(userId);
        const deptWhere = await departmentWhereForUser(userId);
        const baseAnd = [{ status: 'PUBLISHED' }, audiencesWhereLiteral(tokens), deptWhere];
        if (categorySlug) baseAnd.push({ categorySlug });
        const attrs = ['id', 'title', 'slug', 'categorySlug', 'subcategorySlug', 'aiDigest', 'processMeta', 'payload', 'updatedAt'];

        const seen = new Map();

        // 1) Vetorial (se houver embeddings + a query embeddar)
        if (q && await this._hasEmbeddings()) {
            const vec = toPgVector(await this._queryEmbedding(q));
            if (vec) {
                try {
                    const rows = await db.AcademyArticle.findAll({
                        where: { [Op.and]: [...baseAnd, db.Sequelize.literal('embedding IS NOT NULL')] },
                        attributes: attrs,
                        order: db.Sequelize.literal(`embedding <=> '${vec}'::vector`),
                        limit: k,
                        raw: true,
                    });
                    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
                } catch (err) {
                    console.warn('[academyRetrieval] vector search skip:', err?.message);
                }
            }
        }

        // 2) Keyword MULTI-TERMO (sempre roda; único caminho sem pgvector).
        // Tokeniza a pergunta, casa CADA termo em título/corpo/digest (OR p/
        // recall) e rankeia pelo nº de termos batidos (título e digest pesam mais).
        if (q) {
            const terms = tokenizeQuery(q);
            const orConds = [];
            for (const term of terms) {
                const like = `%${term}%`;
                const safe = like.replace(/'/g, "''");
                orConds.push({ title: { [Op.iLike]: like } });
                orConds.push({ body: { [Op.iLike]: like } });
                orConds.push({ categorySlug: { [Op.iLike]: like } });
                orConds.push({ subcategorySlug: { [Op.iLike]: like } });
                orConds.push(db.Sequelize.literal(`ai_digest::text ILIKE '${safe}'`));
            }
            if (orConds.length) {
                const rows = await db.AcademyArticle.findAll({
                    where: { [Op.and]: [...baseAnd, { [Op.or]: orConds }] },
                    attributes: attrs,
                    limit: Math.max(k * 4, 24),
                    raw: true,
                });
                // Ranking ACENTO-INSENSÍVEL (norm) + peso IDF: termos COMUNS na
                // base (ex.: "cadastro", que casa dezenas de artigos) pesam MENOS
                // que termos discriminativos (ex.: "reserva") — assim os "Cadastro
                // de X" não afogam os tutoriais de reserva/pré-cadastro. Título e
                // digest pesam mais que corpo.
                const nterms = [...new Set(terms.map(norm).filter(Boolean))];
                const docs = rows.map((r) => {
                    const dg = r.aiDigest || {};
                    return {
                        r,
                        hayTitle: norm(r.title || ''),
                        // intenção: o que o processo ATENDE (processFor) + keywords —
                        // sinal mais preciso que o corpo p/ "como fazer X".
                        hayAction: norm([...(dg.processFor || []), ...(dg.keywords || [])].join(' . ')),
                        hayDigest: norm(JSON.stringify(dg)),
                        // CATEGORIA/subcategoria como sinal: "reserva" deve puxar a
                        // subcategoria "reservas" (agrupa por área e tira o ruído).
                        hayCat: norm(`${r.categorySlug || ''} ${r.subcategorySlug || ''}`),
                    };
                });
                const N = docs.length || 1;
                const idf = {};
                for (const t of nterms) {
                    let df = 0;
                    for (const d of docs) if (d.hayTitle.includes(t) || d.hayDigest.includes(t)) df++;
                    idf[t] = Math.log((N + 1) / (df + 1)) + 0.5; // suavizado, sempre > 0
                }
                // Título + intenção (processFor/keywords) + CATEGORIA pesam mais que
                // o corpo; IDF reduz o peso de termos comuns (ex.: "cadastro").
                const ranked = docs.map((d) => {
                    let score = 0;
                    for (const t of nterms) {
                        if (d.hayTitle.includes(t)) score += idf[t] * 3;
                        if (d.hayAction.includes(t)) score += idf[t] * 3;
                        else if (d.hayDigest.includes(t)) score += idf[t] * 1.5;
                        if (d.hayCat.includes(t)) score += idf[t] * 2.5; // mesma categoria/subcategoria
                    }
                    return { r: d.r, score };
                }).sort((a, b) => b.score - a.score);
                for (const { r } of ranked) if (!seen.has(r.id)) seen.set(r.id, r);
            }
        }

        const results = [...seen.values()].slice(0, k).map(r => this._toDigestResult(r));
        const data = { results, count: results.length };
        cacheSet(searchCache, cacheKey, { data }, SEARCH_TTL);
        return data;
    },

    // Extrai uma seção do markdown pelo título (iLike) até o próximo heading
    // de nível igual/superior. null se não achar.
    _extractSection(body, section) {
        const want = norm(section);
        if (!want) return null;
        const lines = String(body || '').split('\n');
        let start = -1, headingText = null, startLevel = 0;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
            if (m && norm(m[2]).includes(want)) {
                start = i; headingText = m[2].trim(); startLevel = m[1].length; break;
            }
        }
        if (start < 0) return null;
        const out = [lines[start]];
        for (let i = start + 1; i < lines.length; i++) {
            const m = lines[i].match(/^(#{1,6})\s+/);
            if (m && m[1].length <= startLevel) break;
            out.push(lines[i]);
        }
        return { heading: headingText, text: out.join('\n').trim() };
    },

    /** Corpo (ou seção) de um processo, sob demanda. Truncado (teto de tokens). */
    async getProcess({ slug, userId, section = null }) {
        const tokens = await resolveUserTokens(userId);
        const deptWhere = await departmentWhereForUser(userId);
        const ref = String(slug || '').trim();
        if (!ref) return { found: false };

        const attrs = ['id', 'title', 'slug', 'categorySlug', 'body', 'aiDigest', 'payload'];
        const vis = [audiencesWhereLiteral(tokens), deptWhere];

        // 1) slug exato.
        let article = await db.AcademyArticle.findOne({
            where: { [Op.and]: [{ status: 'PUBLISHED', slug: ref }, ...vis] },
            attributes: attrs, raw: true,
        });
        // 2) Robustez: se o modelo errou o slug (ex.: sem "-cv-crm", parcial, ou
        //    inventado), trata o ref como BUSCA e usa o melhor resultado — assim o
        //    get_process raramente devolve "não encontrei" para um pedido válido.
        if (!article) {
            const { results } = await this.searchProcesses({ query: ref.replace(/[-_]+/g, ' '), userId, k: 1 });
            if (results.length) {
                article = await db.AcademyArticle.findOne({
                    where: { [Op.and]: [{ status: 'PUBLISHED', slug: results[0].slug }, ...vis] },
                    attributes: attrs, raw: true,
                });
                if (!article) {
                    console.warn('[getProcess] fallback findOne failed for slug:', results[0].slug, 'ref:', ref);
                }
            }
        }
        if (!article) {
            console.warn('[getProcess] not found:', { ref, userId });
            return { found: false };
        }

        let body = String(article.body || '');
        let usedSection = null;
        if (section) {
            const sec = this._extractSection(body, section);
            if (sec) { body = sec.text; usedSection = sec.heading; }
        }
        const MAX = 6000;
        let truncated = false;
        if (body.length > MAX) { body = body.slice(0, MAX) + '\n…'; truncated = true; }

        return {
            found: true,
            title: article.title,
            category: article.categorySlug,
            link: `/academy/kb/${encodeURIComponent(article.categorySlug)}/${encodeURIComponent(article.slug)}`,
            section: usedSection,
            content: body,
            truncated,
            videoUrl: videoUrlsFromPayload(article.payload)[0] || null, // URL REAL do vídeo
        };
    },

    _loose(s) { return norm(s).replace(/[^a-z0-9 ]/g, ''); },

    /** "O que preciso para a ação X": processos relacionados + pré-requisitos. */
    async processRequirements({ action, userId, k = 6 }) {
        const { results } = await this.searchProcesses({ query: action, userId, k });
        const a = this._loose(action);
        const scored = results.map(r => ({
            r,
            hit: (r.processFor || []).some(p => {
                const lp = this._loose(p);
                return lp && (lp.includes(a) || a.includes(lp));
            }),
        }));
        // Mantém a forma de digest (com slug) → o tool formata uniforme e o
        // modelo pode pedir get_process(slug) depois.
        const chosen = (scored.some(s => s.hit) ? scored.filter(s => s.hit) : scored).map(s => s.r);
        return { action, processes: chosen, count: chosen.length };
    },
};

export default academyRetrievalService;
