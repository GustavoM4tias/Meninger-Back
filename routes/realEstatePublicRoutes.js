// routes/realEstatePublicRoutes.js
//
// Endpoints PÚBLICOS do cadastro de imobiliária via convite
// (lp.menin.com.br/imobiliaria/<token>). Mesmo padrão das rotas públicas de
// marketing: CORS aberto + body parsers próprios + rate limit por IP.
// A proteção real é o token de convite (CSPRNG, uso único) + validação.

import express from 'express';
import cors from 'cors';
import upload from '../middlewares/uploadMiddleware.js';
import {
    getPublicInvite,
    submitPublicInvite,
    parseCardPublic,
} from '../controllers/realEstateController.js';

const router = express.Router();

router.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], credentials: false }));
router.use(express.json({ limit: '256kb' }));

// ── Rate limit por IP (in-memory) ────────────────────────────────────────────
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.REALESTATE_PUBLIC_RATE_LIMIT) || 20;
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

router.use(rateLimit);

router.get('/invite/:token', getPublicInvite);
router.post('/invite/:token/parse-cnpj-card', upload.single('file'), parseCardPublic);
router.post('/invite/:token/submit', submitPublicInvite);

export default router;
