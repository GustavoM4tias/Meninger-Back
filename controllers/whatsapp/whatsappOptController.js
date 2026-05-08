// controllers/whatsapp/whatsappOptController.js
//
// Endpoints do usuário para gerenciar opt-in / opt-out de WhatsApp.

import db from '../../models/sequelize/index.js';
import WhatsAppService from '../../services/whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../../services/whatsapp/WhatsAppConfigService.js';

const { User } = db;

/**
 * GET /api/whatsapp/info
 * Devolve informações PÚBLICAS sobre o WhatsApp do sistema, para qualquer
 * usuário autenticado ver de qual número receberá as mensagens.
 * Nunca retorna secrets.
 */
export const getPublicInfo = async (req, res) => {
    try {
        const cfg = await WhatsAppConfigService.getConfig();
        return res.json({
            display_phone: cfg?.display_phone || null,
            display_name:  cfg?.display_name  || null,
            active:        !!cfg?.active && !cfg?.dry_run,
            ready:         !!cfg?.has_access_token && !!cfg?.phone_number_id,
        });
    } catch (err) {
        console.error('[whatsapp/info]', err);
        return res.status(500).json({ error: 'Falha ao carregar info.' });
    }
};

const isE164 = (s) => /^\+?\d{10,15}$/.test(String(s || '').replace(/[^\d+]/g, ''));
const toE164 = (s) => `+${WhatsAppService.normalizePhone(s)}`;

/**
 * GET /api/whatsapp/opt
 * Estado do opt-in do usuário logado.
 */
export const getOptStatus = async (req, res) => {
    try {
        const u = await User.findByPk(req.user.id, {
            attributes: ['whatsapp_phone', 'whatsapp_consent_at', 'whatsapp_consent_revoked_at'],
        });
        const consented = !!u?.whatsapp_consent_at &&
            (!u?.whatsapp_consent_revoked_at ||
                new Date(u.whatsapp_consent_at) > new Date(u.whatsapp_consent_revoked_at));
        return res.json({
            phone: u?.whatsapp_phone || null,
            consented,
            consent_at: u?.whatsapp_consent_at || null,
            revoked_at: u?.whatsapp_consent_revoked_at || null,
        });
    } catch (err) {
        console.error('[whatsapp/opt/status]', err);
        return res.status(500).json({ error: 'Falha ao carregar status.' });
    }
};

/**
 * POST /api/whatsapp/opt-in
 * body: { phone, accept: true }
 */
export const optIn = async (req, res) => {
    try {
        const { phone, accept } = req.body || {};
        if (!accept) return res.status(400).json({ error: 'É preciso aceitar o termo.' });
        if (!isE164(phone)) return res.status(400).json({ error: 'Telefone inválido. Use formato com DDI (+55…).' });

        const normalized = toE164(phone);
        await User.update(
            {
                whatsapp_phone: normalized,
                whatsapp_consent_at: new Date(),
                whatsapp_consent_revoked_at: null,
            },
            { where: { id: req.user.id } }
        );
        return res.json({ ok: true, phone: normalized });
    } catch (err) {
        console.error('[whatsapp/opt-in]', err);
        return res.status(500).json({ error: 'Falha ao registrar opt-in.' });
    }
};

/**
 * POST /api/whatsapp/opt-out
 */
export const optOut = async (req, res) => {
    try {
        await User.update(
            { whatsapp_consent_revoked_at: new Date() },
            { where: { id: req.user.id } }
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('[whatsapp/opt-out]', err);
        return res.status(500).json({ error: 'Falha ao registrar opt-out.' });
    }
};
