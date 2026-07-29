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

export function requireInternalJobToken(req, res, next) {
    const got = req.headers[INTERNAL_JOB_HEADER];
    if (got && crypto.timingSafeEqual(
        Buffer.from(String(got)),
        Buffer.from(INTERNAL_JOB_TOKEN)
    )) return next();
    return res.status(401).json({ error: 'Token interno inválido.' });
}

export default { INTERNAL_JOB_TOKEN, INTERNAL_JOB_HEADER, requireInternalJobToken };
