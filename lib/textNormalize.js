// src/lib/textNormalize.js
export function normalizeCityName(str = '') {
    return String(str)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim()
}

export function normalizeEnterpriseName(str = '') {
    // remove acento, caixa, pontuação e stopwords curtas comuns
    return String(str)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/(^| )(DE|DA|DO|DAS|DOS|E)( |$)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}
