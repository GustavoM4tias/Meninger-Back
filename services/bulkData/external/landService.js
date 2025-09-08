import { makeExtPgClient } from '../../../lib/extDb.js'; 
/** 
 * Remove prefixo "TR - " e extrai número (pt-BR) como decimal JS
 * "TR - R$ 12.840,41" -> { text: "R$ 12.840,41", value: 12840.41 }
 */
export function parseObstitFirst(val) {
    if (!val || typeof val !== 'string') return { text: null, value: null };
    const cleaned = val.replace(/^TR\s*-\s*/i, '').trim(); // remove "TR - "
    // tenta achar o padrão monetário após R$
    const match = cleaned.match(/R\$\s*([\d\.\,]+)/);
    const numStr = match ? match[1] : cleaned; // fallback: tudo
    const normalized = numStr.replace(/\./g, '').replace(',', '.'); // "12.840,41" -> "12840.41"
    const value = Number.isFinite(Number(normalized)) ? Number(normalized) : null;
    return { text: cleaned, value };
}

/**
 * Busca o primeiro obstit por numdocum, para vários numdocum de uma vez.
 * Estratégia: usa DISTINCT ON para pegar a primeira ocorrência por numdocum.
 * Se precisar de ordenação específica (ex.: por vencimento), ajusta o ORDER BY.
 */
export async function fetchFirstObstitByNumdocum(numbers = []) {
    if (!numbers.length) return new Map();
    const client = makeExtPgClient();
    await client.connect();

    try {
        // DISTINCT ON retorna uma linha por numdocum; 
        // ORDER BY define qual é "a primeira". Ajuste se houver coluna melhor (ex: data de emissão).
        const sql = `
      SELECT DISTINCT ON (d2.numdocum) d2.numdocum, d2.obstit
      FROM dfin_creceber d2
      WHERE d2.numdocum = ANY($1::text[])
      ORDER BY d2.numdocum, d2.obstit; -- ajuste aqui se necessário
    `;
        const { rows } = await client.query(sql, [numbers]);
        const map = new Map();
        for (const r of rows) {
            map.set(String(r.numdocum), String(r.obstit));
        }
        return map;
    } finally {
        await client.end().catch(() => { });
    }
}

/**
 * Pipeline completo:
 * - recebe array de numbers,
 * - busca primeiros obstit em lote (ou em sublotes, se necessário),
 * - retorna Map<numberStr, {text, value}>
 */
export async function getParsedObstitForNumbers(numbers = [], { batchSize = 1000 } = {}) {
    const out = new Map();
    for (let i = 0; i < numbers.length; i += batchSize) {
        const slice = numbers.slice(i, i + batchSize);
        const fetched = await fetchFirstObstitByNumdocum(slice);
        for (const [num, text] of fetched.entries()) {
            const parsed = parseObstitFirst(text);
            out.set(num, parsed);
        }
    }
    return out;
}
