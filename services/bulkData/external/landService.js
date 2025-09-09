import { makeExtPgClient } from '../../../lib/extDb.js';
/**
 * Tokens que indicam TR / Terreno.
 */
const TR_TOKENS = /\b(?:TR|TERRENO|VALOR\s*DO?\s*TERRENO|PARC(?:ELA)?\s*TERRENO|TERRENO\s*\(TR\))\b/i;

/**
 * Converte um texto qualquer em número, ignorando TUDO que não for dígito.
 * Regra: últimos 2 dígitos = centavos. Sempre.
 * Ex.: "R$ 23.820,71" => "2382071" => 23820.71
 *      "23,820,71"    => "2382071"  => 23820.71
 *      "23.820"       => "23820"    => 238.20  (regra pedida: 2 últimos = centavos)
 */
function toNumberDigitsOnly(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D+/g, ''); // só dígitos

  if (!digits) return null;

  if (digits.length === 1) {
    // "7" => 0.07
    return Number(`0.0${digits}`);
  }
  if (digits.length === 2) {
    // "71" => 0.71
    return Number(`0.${digits}`);
  }
  // >= 3 dígitos
  const intPart = digits.slice(0, -2);
  const centPart = digits.slice(-2);
  return Number(`${intPart}.${centPart}`);
}


/**
 * Extrai todos os candidatos a valor monetário de um texto (muito tolerante).
 * Exemplos aceitos:
 *  - "TR - 12.604,50", "TR - R$ 23,820,71"
 *  - "R$12.604,50", "12604,50", "23.820", "12,345.67", etc.
 * Retorna números já normalizados (JS).
 */
export function extractMoneyCandidates(text = '', { strictTR = true } = {}) {
  if (!text || typeof text !== 'string') return [];

  const lines = String(text).split(/\r?\n/);
  const hasTR = lines.map((ln) => TR_TOKENS.test(ln));

  // Pega qualquer sequência iniciada por dígito e que contenha dígitos/separadores
  const numLikeRe = /(\d[\d.,\s]*)/g;

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (strictTR) {
      const neighborTR = hasTR[i] || (i > 0 && hasTR[i - 1]) || (i < lines.length - 1 && hasTR[i + 1]);
      if (!neighborTR) continue;
    }
    let m;
    while ((m = numLikeRe.exec(lines[i])) !== null) {
      const n = toNumberDigitsOnly((m[1] || '').trim());
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

/**
 * Agrega candidatos de vários textos, deduplica por frequência (em centavos)
 * e escolhe um único valor:
 *  - escolhe o valor mais frequente (arred. 2 casas),
 *  - em caso de empate, escolhe o MAIOR.
 * Retorna também um texto de amostra onde o valor aparece (normalizado).
 */
export function chooseLandValue(values = [], { strictTR = true } = {}) {
  const all = [];
  for (const v of values) {
    all.push(...extractMoneyCandidates(String(v || ''), { strictTR }));
  }
  if (all.length === 0) return { text: null, value: null };

  const freq = new Map();
  for (const n of all) {
    const cents = Math.round(n * 100);
    freq.set(cents, (freq.get(cents) || 0) + 1);
  }

  const [bestCents] =
    [...freq.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))[0];

  const value = bestCents / 100;

  // tenta achar um texto que leve ao mesmo número pelo parser "digits only"
  const sampleText =
    String(
      values.find((t) => {
        const parsedInText = extractMoneyCandidates(String(t || ''), { strictTR });
        return parsedInText.some((x) => Math.round(x * 100) === bestCents);
      }) || values[0] || ''
    );

  return { text: sampleText, value };
}

/**
 * Busca TODAS as linhas obstit por numdocum (sem DISTINCT), para vários numdocum.
 */
export async function fetchAllObstitByNumdocum(numbers = []) {
    if (!numbers.length) return new Map();
    const client = makeExtPgClient();
    await client.connect();
    try {
        const sql = `
      SELECT d2.numdocum, d2.obstit
      FROM dfin_creceber d2
      WHERE d2.numdocum = ANY($1::text[])
    `;
        const { rows } = await client.query(sql, [numbers]);
        const map = new Map(); // numdocum -> array de textos
        for (const r of rows) {
            const key = String(r.numdocum);
            const val = String(r.obstit ?? '');
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(val);
        }
        return map;
    } finally {
        await client.end().catch(() => { });
    }
}

/**
 * Pipeline em lotes: usa strictTR=true por padrão.
 */
export async function getParsedObstitForNumbers(numbers = [], { batchSize = 1000 } = {}) {
  const out = new Map();
  for (let i = 0; i < numbers.length; i += batchSize) {
    const slice = numbers.slice(i, i + batchSize);
    const fetched = await fetchAllObstitByNumdocum(slice); // Map<num, string[]>
    for (const [num, texts] of fetched.entries()) {
      const chosen = chooseLandValue(texts, { strictTR: true });
      out.set(num, chosen);
    }
  }
  return out;
}