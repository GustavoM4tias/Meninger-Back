// services/marketing/leadAntiSpam.js
//
// Validação de qualidade e anti-spam para leads captados por formulário público.
//
// IMPORTANTE: anti-spam ≠ deduplicação. Bloqueamos bot/lixo; NUNCA bloqueamos
// "email já visto" — isso é re-entrada legítima (tratada no CvLeadDispatchService
// como nova conversão).

// Campos-armadilha: invisíveis no formulário real (CSS). Se vierem preenchidos,
// quem submeteu foi um bot.
export const HONEYPOT_FIELDS = ['_hp', '_gotcha', 'website', 'homepage'];

export function honeypotTripped(body = {}) {
    return HONEYPOT_FIELDS.some(f => {
        const v = body[f];
        return v !== undefined && v !== null && String(v).trim() !== '';
    });
}

export function normalizeEmail(v) {
    if (!v) return null;
    const e = String(v).trim().toLowerCase();
    return e || null;
}

// Mantém só dígitos; descarta se não parecer telefone (10-13 dígitos, com/sem DDI).
export function normalizePhone(v) {
    if (!v) return null;
    const digits = String(v).replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13 ? digits : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(v) {
    const e = normalizeEmail(v);
    return !!e && e.length <= 255 && EMAIL_RE.test(e);
}

/**
 * Valida o contato mínimo exigido pelo CV: email OU telefone válido.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateLeadContact({ email, telefone } = {}) {
    const reasons = [];
    const emailOk = isValidEmail(email);
    const phoneOk = !!normalizePhone(telefone);
    if (!emailOk && !phoneOk) reasons.push('sem email ou telefone válido');
    if (email && !emailOk) reasons.push('email com formato inválido');
    if (telefone && !phoneOk) reasons.push('telefone com formato inválido');
    return { ok: emailOk || phoneOk, reasons };
}

export default { honeypotTripped, normalizeEmail, normalizePhone, isValidEmail, validateLeadContact, HONEYPOT_FIELDS };
