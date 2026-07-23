// services/emeAtende/emeAtendePhone.js
// Normalização de telefone BR pro formato da Cloud API (E.164 sem "+").
// Match entre formatos com/sem 9º dígito é sempre por SUFIXO (últimos 8).

export function normalizePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^\d]/g, '');
    if (!digits) return null;
    digits = digits.replace(/^0+/, '');
    // 10-11 dígitos = DDD + número sem DDI → assume Brasil
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    return digits;
}

export function phoneSuffix(phone) {
    const n = normalizePhone(phone);
    return n ? n.slice(-8) : null;
}

// Chave canônica p/ COMPARAÇÃO: DDD + últimos 8 do assinante (ignora DDI 55 e o
// 9º dígito móvel). O sufixo puro de 8 dígitos colide entre DDDs diferentes —
// risco de rotear lead como interno ou mesclar conversas de leads distintos.
export function phoneKey(phone) {
    const n = normalizePhone(phone);
    if (!n) return null;
    const rest = n.startsWith('55') && n.length >= 12 ? n.slice(2) : n;
    if (rest.length < 10) return rest; // sem DDD identificável — usa o que tem
    return `${rest.slice(0, 2)}${rest.slice(-8)}`;
}

// true quando os dois números são o MESMO assinante. Se algum dos lados foi
// salvo sem DDD (chave < 10 dígitos), cai no sufixo de 8 — compatível com
// cadastros antigos; quando ambos têm DDD, a comparação é estrita.
export function samePhone(a, b) {
    const ka = phoneKey(a);
    const kb = phoneKey(b);
    if (!ka || !kb) return false;
    if (ka.length >= 10 && kb.length >= 10) return ka === kb;
    return ka.slice(-8) === kb.slice(-8);
}
