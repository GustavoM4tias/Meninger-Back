// routes/marketingPublicRoutes.js
//
// Endpoints PÚBLICOS (sem autenticação) da captação de marketing.
// Montado cedo no server.js, com CORS permissivo e body parsers próprios — uma
// página/formulário de captação pode estar em qualquer domínio. A proteção é o
// anti-spam (honeypot + rate limit + validação), não o CORS.

import express from 'express';
import cors from 'cors';
import { submitLeadForm } from '../controllers/marketing/leadFormController.js';
import { getPublicLeadForm } from '../controllers/marketing/publicLeadFormController.js';

const router = express.Router();

// CORS aberto: endpoint de captação é público por natureza.
router.use(cors({ origin: true, methods: ['POST', 'OPTIONS'], credentials: false }));
router.use(express.json({ limit: '256kb' }));
router.use(express.urlencoded({ extended: true, limit: '256kb' }));

// ── Rate limit por IP (in-memory) ───────────────────────────────────────────
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.MARKETING_FORM_RATE_LIMIT) || 10; // submits/min por IP
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

// GET /api/marketing/public/forms/:slug/page — config para o renderer da LP
router.get('/forms/:slug/page', getPublicLeadForm);

// POST /api/marketing/public/forms/:slug/submit
router.post('/forms/:slug/submit', rateLimit, submitLeadForm);

export default router;
