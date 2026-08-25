// security/internalJobToken.js
//
// Token para chamadas SERVER-TO-SERVER dentro do próprio processo/deploy
// (ex.: job de análise automática de contratos → POST /api/ai/validator).
// Sem env INTERNAL_JOB_TOKEN, gera um token aleatório por boot — como o
// chamador importa ESTE módulo, o valor sempre casa dentro do processo e
// nunca é conhecido de fora.

import crypto from 'crypto';

export const INTERNAL_JOB_TOKEN =
    process.env.INTERNAL_JOB_TOKEN || crypto.randomBytes(32).toString('hex');

export const INTERNAL_JOB_HEADER = 'x-internal-job-token';

// timingSafeEqual EXIGE buffers do mesmo tamanho, e comparar o header cru
// estourava (500 em vez de 401) sempre que o tamanho não batia. Comparando o
// sha256 dos dois, o tamanho é sempre 32 bytes e a comparação continua em
// tempo constante.
const digest = (valor) => crypto.createHash('sha256').update(String(valor)).digest();

/** O pedido traz o token interno deste processo? Não responde nada. */
export function hasValidInternalJobToken(req) {
    const got = req?.headers?.[INTERNAL_JOB_HEADER];
    if (!got) return false;
    return crypto.timingSafeEqual(digest(got), digest(INTERNAL_JOB_TOKEN));
}

export function requireInternalJobToken(req, res, next) {
    if (hasValidInternalJobToken(req)) return next();
    return res.status(401).json({ error: 'Token interno inválido.' });
}

export default {
    INTERNAL_JOB_TOKEN,
    INTERNAL_JOB_HEADER,
    hasValidInternalJobToken,
    requireInternalJobToken,
};
