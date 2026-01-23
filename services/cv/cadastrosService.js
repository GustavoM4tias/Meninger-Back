import apiCv from '../../lib/apiCv.js';

export function onlyDigits(s) {
    return String(s || '').replace(/\D/g, '');
}

export async function fetchBrokerByDocument(document) {
    const doc = onlyDigits(document);
    const resp = await apiCv.get('/v1/cadastros/corretores', {
        params: { documento: doc, limit: 1, offset: 0 }
    });

    const data = resp?.data;
    if (!data) return null;

    // seu exemplo: { corretor: {...} }
    if (data.corretor) return data.corretor;

    // fallback: array
    if (Array.isArray(data) && data.length) return data[0];
    if (Array.isArray(data?.corretores) && data.corretores.length) return data.corretores[0];

    return null;
}

export async function fetchRealEstateUserByDocument(document) {
    const doc = onlyDigits(document);
    const resp = await apiCv.get('/v1/cadastros/usuarios-imobiliarias', {
        params: { documento: doc, limit: 1, offset: 0 }
    });

    const data = resp?.data;
    const u = data?.usuarios?.[0];
    return u || null;
}

export async function fetchCorrespondentUserByDocument(document) {
    const doc = onlyDigits(document);
    if (!doc || doc.length !== 11) return null;

    const perPage = 500;         // máximo permitido
    const maxPages = 200;        // proteção contra loop infinito (ajuste se necessário)

    for (let page = 1; page <= maxPages; page++) {
        const resp = await apiCv.get('/v2/cadastros/correspondentes-usuarios', {
            params: { pagina: page, registros_por_pagina: perPage },
        });

        const data = resp?.data;
        const list = Array.isArray(data?.dados) ? data.dados : [];

        const found = list.find(u => onlyDigits(u?.documento) === doc);
        if (found) return found;

        const totalPages = Number(data?.total_de_paginas || 0);
        if (totalPages && page >= totalPages) break;

        // fallback: se não veio total_de_paginas, para quando não tiver mais dados
        if (!list.length) break;
    }

    return null;
}