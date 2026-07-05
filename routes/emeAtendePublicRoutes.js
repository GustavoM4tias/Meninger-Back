// routes/emeAtendePublicRoutes.js
//
// Intake público de leads da Eme Atende: POST /api/eme-atende/public/leads
// Auth por X-Api-Key (eme_atende_api_keys, sha256) - qualquer sistema integra.

import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import db from '../models/sequelize/index.js';
import EmeAtendeLeadIntakeService from '../services/emeAtende/EmeAtendeLeadIntakeService.js';

const router = express.Router();

const intakeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.EME_ATENDE_INTAKE_RATE_LIMIT || 120),
    standardHeaders: true,
    legacyHeaders: false,
});

async function apiKeyAuth(req, res, next) {
    try {
        const key = req.header('x-api-key');
        if (!key) return res.status(401).json({ error: 'X-Api-Key ausente.' });
        const hash = crypto.createHash('sha256').update(key).digest('hex');
        const row = await db.EmeAtendeApiKey.findOne({ where: { key_hash: hash, active: true } });
        if (!row) return res.status(401).json({ error: 'API key inválida.' });
        row.update({ last_used_at: new Date() }).catch(() => {});
        req.apiKeyName = row.name;
        next();
    } catch (err) {
        console.error('[eme-atende/auth] apiKeyAuth:', err?.message);
        res.status(500).json({ error: 'Erro interno.' });
    }
}

/**
 * POST /leads
 * body: { name, phone*, email, source, campaign, empreendimento, external_id, ...extras }
 */
router.post('/leads', intakeLimiter, apiKeyAuth, async (req, res) => {
    try {
        const { lead, conversation, reentry, reopened } = await EmeAtendeLeadIntakeService.ingest(
            req.body || {},
            { apiKeyName: req.apiKeyName }
        );
        res.status(reentry ? 200 : 201).json({
            id: lead.id,
            status: lead.status,
            conversation_id: conversation?.id || null,
            reentry: !!reentry,
            reopened: !!reopened,
        });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[eme-atende/intake]', err);
        res.status(status).json({ error: err.message || 'Erro interno.' });
    }
});

export default router;
