// services/academy/academyDigestService.js
//
// Gera, 1× por artigo (no publish ou via backfill), um DIGEST estruturado + um
// EMBEDDING — base da economia de tokens da Eme: a maioria das perguntas é
// respondida só com digests, sem carregar o corpo. Idempotente por digest_hash:
// só regenera quando o conteúdo muda. Sem chave Gemini → no-op silencioso.

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import { embedText, generateJson, toPgVector, hasGeminiKey } from '../OfficeAI/geminiClient.js';

function hashBody(body) {
    return crypto.createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

// pgvector disponível? (coluna `embedding` existe). Cacheado por processo —
// evita 1 chamada de embedding desperdiçada por artigo quando não há pgvector.
let _embeddingColOk = null;
async function embeddingColumnExists() {
    if (_embeddingColOk !== null) return _embeddingColOk;
    try {
        await db.sequelize.query(`SELECT embedding FROM academy_articles LIMIT 0`);
        _embeddingColOk = true;
    } catch {
        _embeddingColOk = false;
    }
    return _embeddingColOk;
}

// Limpa markdown/tokens p/ baratear o input do digest+embedding.
function plainText(body) {
    let s = String(body || '');
    s = s.replace(/```[\s\S]*?```/g, ' ');          // blocos de código
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');     // imagens
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');   // [txt](url) → txt
    s = s.replace(/@\[[A-Z_]+:[^\]]+\]/g, ' ');      // embeds @[X:y]
    s = s.replace(/[#>*_`~|]+/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

function buildDigestPrompt({ title, category, body }) {
    return `Você é um analista de processos. Resuma o PROCESSO/PROCEDIMENTO abaixo de forma FIEL — sem inventar nada que não esteja no texto.

Título: ${title}
Categoria: ${category}
Conteúdo:
"""
${plainText(body).slice(0, 12000)}
"""

Responda APENAS um JSON:
{
  "resumo": "2-3 frases objetivas: o que é e para que serve",
  "processFor": ["ações/objetivos que este processo atende (ex: 'cadastrar fornecedor', 'pagar reembolso')"],
  "prerequisites": ["processos/condições necessários ANTES deste, em frases curtas"],
  "steps": ["títulos curtos das etapas principais (máx. 8)"],
  "systems": ["sistemas/ferramentas citados (ex: 'Sienge', 'Construtor de Vendas')"],
  "keywords": ["termos de busca relevantes"]
}
Português. Arrays vazios quando não houver. NUNCA invente prazos, números ou nomes ausentes do texto.`;
}

// Texto denso e barato p/ o embedding: título + resumo + ações + keywords + aliases.
function buildEmbInput(article, digest) {
    const aliases = Array.isArray(article.aliases) ? article.aliases.join(' ') : '';
    return [
        article.title,
        digest?.resumo || '',
        (digest?.processFor || []).join(' '),
        (digest?.keywords || []).join(' '),
        aliases,
    ].filter(Boolean).join(' . ');
}

async function writeEmbedding(articleId, embedding) {
    const vec = toPgVector(embedding);
    try {
        await db.sequelize.query(
            `UPDATE academy_articles SET embedding = :vec::vector WHERE id = :id`,
            { replacements: { vec, id: articleId } }
        );
        return true;
    } catch (err) {
        // pgvector ausente → segue só com digest (busca por keyword).
        console.warn('[academyDigest] embedding skip:', err?.message);
        return false;
    }
}

const academyDigestService = {
    /**
     * Gera/regenera digest + embedding de um artigo, se necessário.
     * @returns {Promise<{updated:boolean, reason?:string}>}
     */
    async ensureForArticle(article, { force = false } = {}) {
        if (!article) return { updated: false, reason: 'no-article' };
        const body = article.body || '';
        const hash = hashBody(body);

        if (!force && article.digestHash === hash && article.aiDigest) {
            // Digest em dia — mas se o pgvector foi habilitado DEPOIS do digest,
            // o embedding pode estar faltando. Gera SÓ o embedding a partir do
            // digest existente (sem nova chamada de digest).
            if (hasGeminiKey() && await embeddingColumnExists()) {
                const [rows] = await db.sequelize.query(
                    `SELECT (embedding IS NOT NULL) AS has FROM academy_articles WHERE id = :id`,
                    { replacements: { id: article.id } }
                );
                const hasEmb = Array.isArray(rows) ? !!rows[0]?.has : false;
                if (!hasEmb) {
                    const embedding = await embedText(buildEmbInput(article, article.aiDigest), { taskType: 'RETRIEVAL_DOCUMENT' });
                    if (embedding && await writeEmbedding(article.id, embedding)) {
                        return { updated: true, reason: 'embedding-backfill' };
                    }
                }
            }
            return { updated: false, reason: 'up-to-date' };
        }
        if (!hasGeminiKey()) return { updated: false, reason: 'no-key' };

        const digest = await generateJson(buildDigestPrompt({
            title: article.title, category: article.categorySlug, body,
        }));
        if (!digest || typeof digest !== 'object') return { updated: false, reason: 'digest-failed' };

        const embInput = buildEmbInput(article, digest);
        // Embedding só se a coluna pgvector existir — senão é chamada
        // desperdiçada (sem pgvector a busca usa keyword + digests).
        const embedding = (await embeddingColumnExists())
            ? await embedText(embInput, { taskType: 'RETRIEVAL_DOCUMENT' })
            : null;

        // digest + hash via Sequelize; embedding via SQL cru (pgvector).
        await db.AcademyArticle.update(
            { aiDigest: digest, digestHash: hash },
            { where: { id: article.id } }
        );
        if (embedding) await writeEmbedding(article.id, embedding);
        return { updated: true };
    },

    async ensureForArticleId(articleId, opts = {}) {
        const article = await db.AcademyArticle.findByPk(articleId, {
            attributes: ['id', 'title', 'categorySlug', 'body', 'aliases', 'aiDigest', 'digestHash'],
        });
        return this.ensureForArticle(article, opts);
    },
};

export default academyDigestService;
