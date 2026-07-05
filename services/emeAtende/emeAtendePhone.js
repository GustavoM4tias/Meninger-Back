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
