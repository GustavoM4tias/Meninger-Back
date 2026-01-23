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
