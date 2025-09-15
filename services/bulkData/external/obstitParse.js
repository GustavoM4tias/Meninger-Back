// src/services/external/obstitParse.js  (TR-only, dígitos apenas, sem multiplicadores)
// AJUSTADO p/ ser mais tolerante entre TR e número e ampliar faixas

// aceita TR colado e TR seguido de qualquer coisa não-numérica até encontrar dígitos
const TR_TOKENS = /(?:\bTR\b|TR(?=[^0-9]*\d))/i;

function normalizeUnicode(text = '') {
  return String(text)
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F]/g, ' ')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/['’`]/g, '.') // apóstrofo como milhar
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCurrency(text = '') {
  return String(text)
    .replace(/\b(?:R\$|US\$|U\$S|\$|€|£|BRL|USD|EUR)\b/gi, '')
    .replace(/[≈~;)(\[\]{}]/g, '')
    .trim();
}

/**
 * "10,000,00" → última vírgula = decimal; anteriores viram ponto → "10.000,00"
 * completa centavo único: ",9" → ",90"
 */
function normalizeSeparators(token = '') {
  let t = token;
  const commas = [...t.matchAll(/,/g)].map(m => m.index);
  if (commas.length >= 2) {
    const last = commas[commas.length - 1];
    const tail = t.slice(last + 1);
    if (/^\s*\d{2}\b/.test(tail)) {
      t = t.slice(0, last).replace(/,/g, '.') + ',' + t.slice(last + 1);
    }
  }
  t = t.replace(/([.,]\s*)(\d)(?!\d)/, '$10$2');
  return t;
}

function prepareMoneyToken(raw = '') {
  return normalizeSeparators(stripCurrency(normalizeUnicode(raw)));
}

/**
 * Conversão "inteligente":
 * - vírgula → decimal BR; pontos/espaços → milhar
 * - só ponto → milhar (sem decimais)
 * - sem vírgula/ponto:
 *   - len >= 7 → centavos colados (últimos 2)
 *   - len <= 6 → inteiro em reais
 */
function toNumberSmart(raw) {
  if (raw == null) return null;
  const s = prepareMoneyToken(String(raw));

  if (s.includes(',')) {
    const withoutThousands = s.replace(/\./g, '').replace(/\s+/g, '');
    const normalized = withoutThousands.replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }

  if (s.includes('.')) {
    const intStr = s.replace(/\./g, '').replace(/\s+/g, '');
    if (!/^\d+$/.test(intStr)) return null;
    return Number(intStr);
  }

  const digits = s.replace(/\s+/g, '');
  if (!/^\d+$/.test(digits)) return null;

  if (digits.length >= 7) {
    const intPart = digits.slice(0, -2);
    const centPart = digits.slice(-2);
    return Number(`${intPart}.${centPart}`);
  } else {
    return Number(digits);
  }
}

/**
 * Procura o 1º número após "TR".
 * - mesma linha: permite até 40 chars não-numéricos entre TR e o número
 * - próxima linha: olha até lookaheadChars
 */
function extractAfterTR(line = '', nextLine = '', lookaheadChars = 64) {
  const out = [];
  if (!line || !TR_TOKENS.test(line)) return out;

  const mTR = /TR/i.exec(line);
  const start = mTR ? (mTR.index + mTR[0].length) : -1;
  if (start < 0) return out;

  const after = line.slice(start);
  // permite lixo não-numérico antes do primeiro dígito
  const numRe = /^[^\d]{0,40}(\d[\d.\s,'`]*\d|\d)/;

  let m = numRe.exec(after);
  if (!m && nextLine) {
    const head = nextLine.slice(0, Math.max(0, lookaheadChars));
    m = numRe.exec(head);
  }

  if (m) {
    const val = toNumberSmart(m[1]);
    if (Number.isFinite(val)) out.push(val);
  }

  return out;
}

export function extractMoneyCandidates(text = '', { nextLineLookahead = 64 } = {}) {
  if (!text || typeof text !== 'string') return [];
  const lines = String(text).split(/\r?\n/);
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    if (!TR_TOKENS.test(lines[i])) continue;
    const next = i < lines.length - 1 ? lines[i + 1] : '';
    results.push(...extractAfterTR(lines[i], next, nextLineLookahead));
  }
  return results;
}

/**
 * Filtro rígido: só aceita valores na faixa e com tamanho plausível em centavos.
 * Sem fallback sem TR.
 */
export function chooseLandValue(blocks = [], {
  min = 10000,         // >= R$ 10.000,00
  max = 1000000,     // até R$ 1.000.000,00 (evita cortar legítimos > 100k)
  digitLenMin = 6,     // "10000,00" → 1000000 centavos → len 7 (ok)
  digitLenMax = 10,    // margem ampla p/ valores grandes
  nextLineLookahead = 48,
} = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) return { text: null, value: null };

  const bucket = [];

  for (const block of blocks) {
    const lines = String(block || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!TR_TOKENS.test(lines[i])) continue;
      const next = i < lines.length - 1 ? lines[i + 1] : '';
      const vals = extractAfterTR(lines[i], next, nextLineLookahead);

      for (const v of vals) {
        const cents = Math.round(v * 100);
        const digits = String(cents);
        const digitOK = digits.length >= digitLenMin && digits.length <= digitLenMax;
        const inRange = v >= min && v <= max;
        if (!(digitOK && inRange)) continue;

        bucket.push({ cents, val: v, source: lines[i] });
      }
    }
  }

  if (!bucket.length) return { text: null, value: null };

  bucket.sort((a, b) => (b.cents - a.cents)); // desempate simples (pega maior)
  const best = bucket[0];
  return { text: best.source, value: best.cents / 100 };
}
