// services/emeAtende/emeAtendeGuard.js
//
// Trava anti-alucinação da Eme Atende.
//
// O HARD_RULES do prompt pede "nunca invente preço, prazo ou condição" — mas
// isso é instrução, não garantia. Aqui a resposta é CONFERIDA antes de sair:
// todo valor de dinheiro, percentual e data que aparecer no texto precisa estar
// no contexto do negócio (business_context + o que o ContextBuilder puxou do CV
// e da ficha comercial). O que não estiver, é invenção.
//
// Por que não reusar o validador da Eme do Office: lá a conferência é contra o
// RESULTADO DE UMA TOOL (números estruturados). Aqui a resposta nasce de um
// bloco de texto, então o que se aproveita é a ideia (extrair o autoritativo,
// comparar, mandar reescrever, bloquear se não convergir), não o código.
//
// Níveis (eme_atende_settings.validation_level):
//   off         - desliga a conferência
//   money_dates - dinheiro, percentual e data/prazo (padrão)
//   strict      - qualquer número com 2+ dígitos

// Dinheiro: R$ 1.234,56 | 350 mil | 1,2 milhão (o modelo escreve sem acento
// com frequência, então "milhao"/"milhoes" também contam)
const MONEY_RE = /R\$\s*[\d.,]+|\b\d[\d.,]*\s*(?:mil|milh(?:ão|ões|ao|oes)|reais)\b/gi;
// Percentual: 10% | 8,5 %
const PCT_RE = /\b\d[\d.,]*\s*%/g;
// Data/prazo: 12/2027 | 10/03/2026 | março de 2027 | em 2028 | 36 meses
const DATE_RE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*\s+de\s+\d{4}\b|\b20\d{2}\b|\b\d{1,3}\s*(?:meses|m[êe]s|anos|ano|dias|dia)\b/gi;
// Qualquer número de 2+ dígitos (nível strict)
const ANYNUM_RE = /\b\d[\d.,]*\b/g;

/**
 * Reduz um trecho a só os dígitos. Serve pra data e percentual, onde o que
 * importa é a sequência ("12/2027" x "122027").
 */
function digitsOf(s) {
    return String(s || '').replace(/[^\d]/g, '');
}

/**
 * Valor NUMÉRICO de um trecho de dinheiro. Sem isto, "350 mil" e
 * "R$ 350.000,00" pareceriam valores diferentes e a IA seria obrigada a
 * reescrever uma resposta correta.
 *
 * Formato BR: com vírgula, ela é o decimal e o ponto é milhar
 * ("350.000,00" = 350000). Sem vírgula, o ponto é milhar ("350.000" = 350000).
 *
 * @returns {number|null} null quando não dá pra ler um número.
 */
export function moneyValue(s) {
    const raw = String(s || '').toLowerCase();
    const num = raw.match(/\d[\d.,]*/);
    if (!num) return null;

    let n = num[0];
    n = n.includes(',')
        ? n.replace(/\./g, '').replace(',', '.')   // 350.000,00 → 350000.00
        : n.replace(/\.(?=\d{3}\b)/g, '');         // 350.000 → 350000 (mas 1.5 fica 1.5)

    let value = Number(n);
    if (!Number.isFinite(value)) return null;

    if (/milh(ão|ões|ao|oes)/.test(raw)) value *= 1_000_000;
    else if (/\bmil\b/.test(raw)) value *= 1_000;

    return value;
}

const isMoneyish = (s) => /R\$|mil|milh|reais/i.test(String(s || ''));

// Cada trecho carrega o TIPO: dinheiro compara por valor, o resto por dígitos,
// e só número solto ganha a isenção de "1 dígito é ruído de conversa".
const KINDS = [
    { kind: 'money', re: MONEY_RE },
    { kind: 'pct',   re: PCT_RE },
    { kind: 'date',  re: DATE_RE },
    { kind: 'num',   re: ANYNUM_RE },
];

function collect(text, kinds) {
    const out = [];
    for (const { kind, re } of kinds) {
        const matches = String(text || '').match(re) || [];
        for (const m of matches) out.push({ text: m, kind });
    }
    return out;
}

function kindsFor(level) {
    return level === 'strict' ? KINDS : KINDS.filter(k => k.kind !== 'num');
}

/**
 * Valores citados na resposta que NÃO aparecem no contexto autoritativo.
 *
 * @param {string} answer  texto que a IA quer mandar
 * @param {string} context bloco de contexto do negócio usado no prompt
 * @param {string} level   off | money_dates | strict
 * @returns {string[]} trechos suspeitos (vazio = pode enviar)
 */
export function findUnsupported(answer, context, level = 'money_dates') {
    if (level === 'off' || !answer) return [];

    const cited = collect(answer, kindsFor(level));
    if (!cited.length) return [];

    // O contexto sempre é lido inteiro (todos os tipos): se "350000" está lá,
    // "R$ 350.000" na resposta é legítimo independente do nível.
    const ctxTokens = collect(context, KINDS);
    const allowedDigits = new Set(ctxTokens.map(t => digitsOf(t.text)).filter(Boolean));
    // Valores autorizados vêm de dinheiro e de números soltos do contexto —
    // datas ficam de fora de propósito: "12/2027" não pode autorizar "R$ 12".
    const allowedValues = new Set(
        ctxTokens
            .filter(t => t.kind === 'money' || t.kind === 'num')
            .map(t => moneyValue(t.text))
            .filter(v => v !== null)
    );

    const suspicious = [];
    for (const { text: c, kind } of cited) {
        const d = digitsOf(c);
        if (!d) continue;

        // Dinheiro só é autorizado por VALOR. Comparar sequência de dígitos aqui
        // deixava passar coincidência: "1,2 milhao" virava "12", que existia no
        // contexto por causa de "12/2027".
        if (kind === 'money' || isMoneyish(c)) {
            const v = moneyValue(c);
            if (v === null || !allowedValues.has(v)) suspicious.push(c.trim());
            continue;
        }

        // Só número SOLTO de 1 dígito é ruído ("1 quarto", "2 vagas").
        // "5%" é afirmação e precisa de respaldo.
        if (kind === 'num' && d.length < 2) continue;
        if (allowedDigits.has(d)) continue;

        suspicious.push(c.trim());
    }
    return [...new Set(suspicious)];
}

/** Instrução de reescrita mandada de volta ao modelo. */
export function rewriteInstruction(suspicious) {
    return 'Sua resposta citou valores que NÃO estão no contexto do negócio: '
        + suspicious.map(s => `"${s}"`).join(', ') + '. '
        + 'Reescreva a resposta SEM esses valores. Se o lead perguntou exatamente isso, '
        + 'diga com naturalidade que vai confirmar a informação e retornar. '
        + 'Responda apenas com o novo texto, no mesmo tom e tamanho.';
}

/**
 * Resposta de fail-safe quando nem a reescrita converge: não inventa e não
 * deixa o lead no vácuo.
 */
export const SAFE_FALLBACK =
    'Deixa eu confirmar esse detalhe certinho com a equipe pra não te passar '
    + 'informação errada. Já te retorno por aqui!';

export default { findUnsupported, rewriteInstruction, SAFE_FALLBACK };
