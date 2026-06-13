// middlewares/rateLimiters.js
//
// Rate limiters para endpoints sensíveis de autenticação. Usa express-rate-limit
// (já é dependência). Os limites são generosos o suficiente para não atrapalhar
// uso legítimo — inclusive vários usuários atrás do mesmo IP de escritório (NAT) —
// mas cortam brute-force / credential-stuffing automatizado.
//
// Depende de `app.set('trust proxy', 1)` no server.js para que req.ip seja o IP
// real do cliente (e não o do proxy do Railway). Limites ajustáveis por env.
import rateLimit from 'express-rate-limit';

const common = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Resposta no mesmo formato JSON que o resto da API.
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    });
  },
};

// Login por senha e por face: barreira de rede contra brute-force.
// Default: 40 tentativas / 10 min por IP.
export const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT || 40),
  ...common,
});

// Fluxo de recuperação de senha. O controller já limita por conta (tentativas,
// TTL, throttle de reenvio); isto é a barreira por IP.
// Default: 20 / 15 min por IP.
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PASSWORD_RESET_RATE_LIMIT || 20),
  ...common,
});
