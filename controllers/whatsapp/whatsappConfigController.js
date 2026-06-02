// controllers/whatsapp/whatsappConfigController.js
//
// Endpoints admin para gerenciar a config singleton do WhatsApp Cloud API.

import crypto from 'crypto';
import WhatsAppConfigService from '../../services/whatsapp/WhatsAppConfigService.js';
import WhatsAppService from '../../services/whatsapp/WhatsAppService.js';
import WhatsAppTemplateService from '../../services/whatsapp/WhatsAppTemplateService.js';

/** GET /api/whatsapp/config — retorna config sem secrets */
export const getConfig = async (req, res) => {
    try {
        const cfg = await WhatsAppConfigService.getConfig();
        return res.json({ config: cfg });
    } catch (err) {
        console.error('[whatsapp/config/get]', err);
        return res.status(500).json({ error: 'Falha ao carregar config.' });
    }
};

/** PUT /api/whatsapp/config — atualiza config (secrets ficam criptografados) */
export const updateConfig = async (req, res) => {
    try {
        const updated = await WhatsAppConfigService.updateConfig(req.body || {});
        return res.json({ config: updated });
    } catch (err) {
        console.error('[whatsapp/config/update]', err);
        return res.status(500).json({ error: 'Falha ao salvar config.' });
    }
};

/** POST /api/whatsapp/config/health — testa conexão com a Meta */
export const healthCheck = async (req, res) => {
    try {
        const result = await WhatsAppService.healthCheck();
        await WhatsAppConfigService.recordHealth({ ok: result.ok, error: result.error });
        return res.json(result);
    } catch (err) {
        console.error('[whatsapp/config/health]', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

/** POST /api/whatsapp/config/sync-templates — sincroniza templates com a Meta */
export const syncTemplates = async (req, res) => {
    try {
        const result = await WhatsAppTemplateService.syncFromMeta();
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[whatsapp/config/sync-templates]', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
};

/**
 * POST /api/whatsapp/config/discover
 * body: { access_token, api_version? }
 * Retorna a árvore Business → WABA → Phone descoberta com aquele token.
 * Usado pelo Setup Wizard para o admin escolher de combos em vez de copiar IDs.
 */
export const discover = async (req, res) => {
    try {
        const { access_token, api_version } = req.body || {};
        if (!access_token) return res.status(400).json({ error: 'access_token é obrigatório.' });
        const data = await WhatsAppService.discoverFromToken({
            accessToken: access_token,
            apiVersion: api_version || 'v21.0',
        });
        return res.json({ ok: true, ...data });
    } catch (err) {
        console.error('[whatsapp/config/discover]', err);
        return res.status(400).json({ ok: false, error: err.message, code: err.code, details: err.details });
    }
};

/**
 * POST /api/whatsapp/config/apply-discovered
 * body: {
 *   access_token, api_version?,
 *   business_id, waba_id, phone_number_id,
 *   display_phone?, display_name?,
 *   app_secret?,
 *   webhook_verify_token? (se vazio, gera um aleatório),
 *   active?, dry_run?
 * }
 * Salva tudo de uma vez na config singleton.
 */
export const applyDiscovered = async (req, res) => {
    try {
        const {
            access_token, api_version,
            business_id, waba_id, phone_number_id,
            display_phone, display_name,
            app_secret, webhook_verify_token,
            active, dry_run,
        } = req.body || {};

        if (!access_token)    return res.status(400).json({ error: 'access_token é obrigatório.' });
        if (!business_id)     return res.status(400).json({ error: 'business_id é obrigatório.' });
        if (!waba_id)         return res.status(400).json({ error: 'waba_id é obrigatório.' });
        if (!phone_number_id) return res.status(400).json({ error: 'phone_number_id é obrigatório.' });

        const verifyToken = webhook_verify_token || crypto.randomBytes(24).toString('hex');

        const updated = await WhatsAppConfigService.updateConfig({
            business_id,
            waba_id,
            phone_number_id,
            display_phone: display_phone || undefined,
            display_name: display_name || undefined,
            api_version: api_version || 'v21.0',
            active: typeof active === 'boolean' ? active : undefined,
            dry_run: typeof dry_run === 'boolean' ? dry_run : undefined,
            access_token,                                  // será criptografado
            app_secret: app_secret || undefined,           // só sobrescreve se vier
            webhook_verify_token: verifyToken,             // sempre grava (gerado se vazio)
        });

        // health check imediato pra validar
        const health = await WhatsAppService.healthCheck().catch(() => ({ ok: false, error: 'falha ao testar' }));
        await WhatsAppConfigService.recordHealth({ ok: health.ok, error: health.error });

        return res.json({
            ok: true,
            config: updated,
            health,
            generated_verify_token: !webhook_verify_token ? verifyToken : null, // expõe só se foi gerado agora
        });
    } catch (err) {
        console.error('[whatsapp/config/apply-discovered]', err);
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/whatsapp/config/register-phone
 * body: { pin }   — 6 dígitos
 *
 * Registra o phone_number_id atual na Cloud API. Necessário 1× depois de
 * adicionar um número novo à WABA (antes do primeiro envio).
 */
export const registerPhone = async (req, res) => {
    try {
        const { pin } = req.body || {};
        const r = await WhatsAppService.registerPhoneNumber({ pin });
        return res.json({ ok: true, ...r });
    } catch (err) {
        console.error('[whatsapp/config/register-phone]', err);
        return res.status(400).json({ ok: false, error: err.message, code: err.code, details: err.details });
    }
};

/** POST /api/whatsapp/config/test-send — envia template de teste para um número */
export const testSend = async (req, res) => {
    try {
        const { to, templateName, language = 'pt_BR', variables = [] } = req.body || {};
        if (!to || !templateName) {
            return res.status(400).json({ error: 'to e templateName são obrigatórios.' });
        }
        const result = await WhatsAppService.sendTemplate({
            to, templateName, language, variables,
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[whatsapp/config/test-send]', err);
        return res.status(400).json({ ok: false, error: err.message, code: err.code, details: err.details });
    }
};
