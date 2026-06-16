// routes/bolaoPublicRoutes.js
//
// Rotas PÚBLICAS do bolão da torcida (menin.com.br/bolao). Sem autenticação,
// CORS aberto (a página pode estar em qualquer domínio do grupo) e body parser
// próprio — mesmo padrão das rotas públicas de captação de marketing. A proteção
// é a validação (CPF + unicidade + deadline) e o rate limit por IP, não o CORS.
//
// Montado em /api/bolao/public ANTES do express.json() global e ANTES do router
// autenticado /api/bolao, então estes caminhos nunca exigem token.

import express from 'express';
import cors from 'cors';
import {
  getPublicOverview, postEnter, postSubmit,
} from '../controllers/bolao/bolaoPublicController.js';

const router = express.Router();

router.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], credentials: false }));
router.use(express.json({ limit: '64kb' }));

// ── Rate limit por IP (in-memory) — barra flood de envios ────────────────────
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.BOLAO_PUBLIC_RATE_LIMIT) || 30;
const hits = new Map();

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const fresh = arr.filter(t => now - t < RL_WINDOW_MS);
    if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
  }
}, 5 * 60 * 1000);
cleanup.unref?.();

function rateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) {
    return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde um instante.' });
  }
  arr.push(now);
  hits.set(ip, arr);
  next();
}

// Leitura do placar + ranking (default slug ou ?slug / :slug).
router.get('/', getPublicOverview);
router.get('/:slug', getPublicOverview);

// Porteiro (valida identidade) e envio definitivo do palpite.
router.post('/:slug/enter', rateLimit, postEnter);
router.post('/:slug/submit', rateLimit, postSubmit);

export default router;
