// services/OfficeAI/promptSafety.js
//
// Anti prompt-injection. Quando interpolamos dados do BD (user.city,
// user.position, enterprise.name) no system prompt, eles podem conter
// caracteres que confundem o modelo ou injetam instruções (ex: a cidade
// "Ignore previous instructions and..." atacaria o prompt).
//
// safeForPrompt: whitelist de caracteres + cap de comprimento.
// É lossy de propósito — preferimos perder caracteres exóticos a expor
// o modelo a injection.

const SAFE_RE = /[^a-zA-ZÀ-ÿ0-9\s.,()\-_/&]/g;

/**
 * Sanitiza string vinda de BD/user para interpolação em prompt.
 * @param {any} input
 * @param {number} maxLen
 * @returns {string}
 */
export function safeForPrompt(input, maxLen = 120) {
    if (input == null) return '';
    let s = String(input);
    // Remove qualquer char fora da whitelist (incluindo `<`, `>`, backticks, `"`, `'`, `\n`, etc.)
    s = s.replace(SAFE_RE, ' ');
    // Colapsa whitespace
    s = s.replace(/\s+/g, ' ').trim();
    // Cap
    if (s.length > maxLen) s = s.slice(0, maxLen);
    return s;
}

/**
 * Sanitiza um array de strings. Items inválidos são pulados (não vira "").
 */
export function safeListForPrompt(arr, maxLen = 80, maxItems = 50) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map(x => safeForPrompt(x, maxLen))
        .filter(Boolean)
        .slice(0, maxItems);
}

/**
 * Detecta strings suspeitas (sinais de prompt injection). Útil para audit log.
 * Retorna lista de razões encontradas (vazia = limpo).
 */
export function detectInjectionSignals(input) {
    if (!input) return [];
    const s = String(input).toLowerCase();
    const signals = [];
    const patterns = [
        { kind: 'override',   re: /\b(ignore|disregard|forget|esqueça|ignore as instruções)\b/ },
        { kind: 'role-flip',  re: /\b(you are now|agora você é|act as|sistema|system:|admin:|user:)\b/ },
        { kind: 'leak',       re: /\b(reveal|show me|mostre|imprima|print|expose).{0,30}\b(prompt|instru[çc][ãa]o|system|chave|api[_ -]?key)/ },
        { kind: 'jailbreak',  re: /\b(jailbreak|DAN|do anything now|sem restrições|sem regras|bypass|sem filtro)\b/ },
        { kind: 'data-exfil', re: /\b(send|envie|exporte|export).{0,40}(http|webhook|external|terceiro)\b/ },
    ];
    for (const p of patterns) if (p.re.test(s)) signals.push(p.kind);
    return signals;
}
