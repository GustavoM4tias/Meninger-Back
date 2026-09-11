// services/OfficeAI/promptRetrieval.js
//
// O que ENTRA no prompt deste turno por similaridade com a pergunta:
//   - blocos do cérebro marcados "por similaridade" (alwaysInPrompt = false);
//   - termos do glossário (vocabulário e voz), mais as palavras proibidas,
//     que vão sempre porque são poucas e valem para qualquer resposta.
//
// Até 11/09/2026 o glossário do Cérebro NUNCA chegava ao prompt: a tela dizia
// "injetado no system prompt", o payload publicado carregava os termos, e o
// montador só concatenava blocos. Aqui ele passa a existir de verdade - só o
// que tem a ver com a pergunta, para não custar 100 linhas por turno.
//
// Configuração em eme_settings.retrieval (tela Cérebro da Eme > Recuperação),
// lida ao vivo com cache curto - vale na hora, sem publicar. Padrões abaixo
// são só o piso quando nada foi configurado.
import db from '../../models/sequelize/index.js';
import { ensureEmbeddings, embedQuery, rank } from './embeddingIndex.js';

export const RETRIEVAL_DEFAULTS = {
    // Roteamento semântico das tools (ToolPreselect): peso somado à pontuação
    // por afinidade; abaixo do limiar a similaridade não conta.
    tools:    { enabled: true, peso: 300, min_sim: 0.35, top_k: 28 },
    // Blocos marcados "por similaridade" no cérebro.
    blocks:   { enabled: true, top_k: 6, min_sim: 0.30 },
    // Glossário: proibidas sempre; vocabulário/voz por similaridade.
    glossary: { enabled: true, top_k: 12, min_sim: 0.30 },
    // Memória (preferências confirmadas) - chave geral; cada pessoa ainda
    // liga/desliga a sua.
    memory:   { enabled: true },
    // Janela quando a pergunta não diz período e a pessoa não escolheu a sua.
    periodo:  { padrao: 'mes_atual' },
};

let _cfg = null;
let _cfgAt = 0;
const CFG_TTL = 30 * 1000;

export function invalidateRetrievalCache() { _cfg = null; _cfgAt = 0; }

function mesclar(base, extra) {
    const out = {};
    for (const k of Object.keys(base)) out[k] = { ...base[k], ...(extra?.[k] && typeof extra[k] === 'object' ? extra[k] : {}) };
    return out;
}

export async function retrievalSettings() {
    if (_cfg && Date.now() - _cfgAt < CFG_TTL) return _cfg;
    let extra = null;
    try {
        const row = await db.EmeSetting.findOne({ where: { key: 'retrieval' }, attributes: ['value'], raw: true });
        extra = row?.value || null;
    } catch { /* sem tabela ainda: padrões */ }
    _cfg = mesclar(RETRIEVAL_DEFAULTS, extra);
    _cfgAt = Date.now();
    return _cfg;
}

/** Valida e normaliza o que a tela manda salvar. */
export function sanitizeRetrievalSettings(input = {}) {
    const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
    const b = (v, d) => (typeof v === 'boolean' ? v : d);
    const D = RETRIEVAL_DEFAULTS;
    return {
        tools: {
            enabled: b(input.tools?.enabled, D.tools.enabled),
            peso: num(input.tools?.peso, D.tools.peso, 0, 2000),
            min_sim: num(input.tools?.min_sim, D.tools.min_sim, 0, 1),
            top_k: num(input.tools?.top_k, D.tools.top_k, 5, 81),
        },
        blocks: {
            enabled: b(input.blocks?.enabled, D.blocks.enabled),
            top_k: num(input.blocks?.top_k, D.blocks.top_k, 0, 30),
            min_sim: num(input.blocks?.min_sim, D.blocks.min_sim, 0, 1),
        },
        glossary: {
            enabled: b(input.glossary?.enabled, D.glossary.enabled),
            top_k: num(input.glossary?.top_k, D.glossary.top_k, 0, 60),
            min_sim: num(input.glossary?.min_sim, D.glossary.min_sim, 0, 1),
        },
        memory: { enabled: b(input.memory?.enabled, D.memory.enabled) },
        periodo: { padrao: ['mes_atual', 'mes_anterior', 'ultimos_30', 'ultimos_90', 'ano_atual', 'ano_anterior', 'tudo'].includes(input.periodo?.padrao) ? input.periodo.padrao : D.periodo.padrao },
    };
}

/**
 * Seleção do turno. Recebe o cérebro ATIVO (payload publicado) - é dele que o
 * prompt sai, então é ele que se embeda; o hash por conteúdo cuida de rascunho
 * e versão nova sem cache velho.
 *
 * @returns {Promise<{blockKeys:Set<string>|null, glossario:object|null, queryVec:number[]|null}>}
 *   blockKeys null = não recorta (todos os blocos entram, como antes).
 */
export async function selecionarParaPrompt({ brain, userMessage, cfg }) {
    const out = { blockKeys: null, glossario: null, queryVec: null };
    if (!brain) return out;

    const precisaVetor = (cfg.blocks.enabled && (brain.blocks || []).some(b => b.alwaysInPrompt === false))
        || (cfg.glossary.enabled && (brain.glossary || []).length);
    if (!precisaVetor) return out;

    const queryVec = await embedQuery(userMessage);
    out.queryVec = queryVec;

    // ── Blocos por similaridade ──────────────────────────────────────────────
    if (cfg.blocks.enabled) {
        const candidatos = (brain.blocks || []).filter(b => b && b.enabled !== false && b.alwaysInPrompt === false && !b.isDynamic);
        if (candidatos.length) {
            const keys = new Set();
            if (queryVec) {
                const vecs = await ensureEmbeddings('block', candidatos.map(b => ({ key: b.key, text: `${b.title}\n${b.content}` })));
                for (const { key, sim } of rank(queryVec, vecs).slice(0, cfg.blocks.top_k)) {
                    if (sim >= cfg.blocks.min_sim) keys.add(key);
                }
            } else {
                // Sem vetor da pergunta (API fora): entra tudo, como antes.
                for (const b of candidatos) keys.add(b.key);
            }
            out.blockKeys = keys;
        }
    }

    // ── Glossário ────────────────────────────────────────────────────────────
    if (cfg.glossary.enabled) {
        const termos = (brain.glossary || []).filter(g => g && g.enabled !== false);
        const proibidas = termos.filter(g => g.kind === 'forbidden');
        const demais = termos.filter(g => g.kind !== 'forbidden');
        let escolhidos = [];
        if (demais.length && queryVec && cfg.glossary.top_k > 0) {
            const vecs = await ensureEmbeddings('glossary', demais.map(g => ({ key: g.key, text: `${g.term} = ${g.canonical || ''} ${g.note || ''}`.trim() })));
            const porKey = new Map(demais.map(g => [g.key, g]));
            escolhidos = rank(queryVec, vecs)
                .filter(r => r.sim >= cfg.glossary.min_sim)
                .slice(0, cfg.glossary.top_k)
                .map(r => porKey.get(r.key))
                .filter(Boolean);
        }
        if (proibidas.length || escolhidos.length) out.glossario = { proibidas, termos: escolhidos };
    }

    return out;
}

/** Bloco de texto do glossário para o prompt. '' quando não há nada. */
export function blocoGlossario(sel) {
    if (!sel) return '';
    const linhas = [];
    if (sel.proibidas?.length) {
        linhas.push('Palavras que você NÃO usa (e o que usar no lugar):');
        for (const g of sel.proibidas) linhas.push(`- "${g.term}" → ${g.canonical || 'evite'}`);
    }
    if (sel.termos?.length) {
        linhas.push('Vocabulário desta conversa (como a pessoa fala → o que ela quer dizer):');
        for (const g of sel.termos) linhas.push(`- ${g.term} → ${g.canonical || g.note || ''}`.trimEnd());
    }
    if (!linhas.length) return '';
    return `\n\n## GLOSSÁRIO\n${linhas.join('\n')}\n`;
}

export default { RETRIEVAL_DEFAULTS, retrievalSettings, sanitizeRetrievalSettings, invalidateRetrievalCache, selecionarParaPrompt, blocoGlossario };
