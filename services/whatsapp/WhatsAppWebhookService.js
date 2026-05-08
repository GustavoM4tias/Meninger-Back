// services/whatsapp/WhatsAppWebhookService.js
//
// Processa eventos recebidos no webhook da Cloud API:
//  - statuses: sent, delivered, read, failed (atualiza WhatsappMessage por meta_message_id)
//  - messages: mensagens recebidas (registra como direction='in' — base para atendimento)
//  - palavras-chave de opt-out ("PARAR", "SAIR", "STOP") -> revoga consentimento
//
// Também valida o payload via X-Hub-Signature-256 quando o app_secret está configurado.

import crypto from 'crypto';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import WhatsAppConfigService from './WhatsAppConfigService.js';

const { WhatsappMessage, User } = db;

const OPT_OUT_KEYWORDS = ['parar', 'sair', 'stop', 'cancelar', 'descadastrar'];

// ─── Verificação de assinatura ────────────────────────────────────────────────

/**
 * Valida assinatura HMAC-SHA256 do header X-Hub-Signature-256.
 * Se app_secret não estiver configurado, retorna true (skip — útil em dev).
 */
async function verifySignature(rawBody, signatureHeader) {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.app_secret) return true;
    if (!signatureHeader) return false;

    const expected = `sha256=${crypto.createHmac('sha256', cfg.app_secret).update(rawBody).digest('hex')}`;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
    } catch {
        return false;
    }
}

/**
 * Verifica o handshake inicial do webhook (modo subscribe).
 * Retorna o challenge se válido, ou null se inválido.
 */
async function verifyHandshake({ mode, token, challenge }) {
    if (mode !== 'subscribe') return null;
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.webhook_verify_token) return null;
    return token === cfg.webhook_verify_token ? String(challenge) : null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const STATUS_MAP = {
    sent:      { status: 'sent',      tsField: 'sent_at' },
    delivered: { status: 'delivered', tsField: 'delivered_at' },
    read:      { status: 'read',      tsField: 'read_at' },
    failed:    { status: 'failed',    tsField: 'failed_at' },
};

async function handleStatusUpdate(s) {
    const wamid = s?.id;
    if (!wamid) return;

    const map = STATUS_MAP[s.status];
    if (!map) return;

    const row = await WhatsappMessage.findOne({ where: { meta_message_id: wamid } });
    if (!row) {
        // recebemos status de uma msg que não temos registro — só loga
        console.warn('[whatsapp/webhook] status para wamid desconhecido:', wamid, s.status);
        return;
    }

    const update = { status: map.status };
    update[map.tsField] = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();

    if (s.status === 'failed') {
        update.error_code = s.errors?.[0]?.code ? String(s.errors[0].code) : null;
        update.error_message = s.errors?.[0]?.title || s.errors?.[0]?.message || 'failed';
    }

    if (s.pricing?.category) {
        update.cost_category = s.pricing.category; // utility/marketing/authentication/service
    }

    await row.update(update);
}

async function handleIncomingMessage(m, fromPhone) {
    // tipos comuns: text, image, document, audio, video, button, interactive, reaction, sticker
    const type = m.type || 'unknown';
    let body = null;
    let mediaUrl = null;

    switch (type) {
        case 'text': body = m.text?.body || ''; break;
        case 'button': body = m.button?.text || ''; break;
        case 'interactive':
            body = m.interactive?.button_reply?.title
                || m.interactive?.list_reply?.title
                || JSON.stringify(m.interactive);
            break;
        default: body = m[type]?.caption || null;
    }

    // Opt-out automático por palavra-chave
    const lower = (body || '').trim().toLowerCase();
    if (OPT_OUT_KEYWORDS.includes(lower)) {
        await User.update(
            { whatsapp_consent_revoked_at: new Date() },
            { where: { whatsapp_phone: { [Op.like]: `%${fromPhone.slice(-9)}` } } }
        );
        console.log('[whatsapp/webhook] opt-out automático para', fromPhone);
    }

    // Tenta amarrar a um user pelo telefone (últimos 9 dígitos = celular sem DDI)
    let userId = null;
    if (fromPhone) {
        const u = await User.findOne({
            where: { whatsapp_phone: { [Op.like]: `%${fromPhone.slice(-9)}` } },
            attributes: ['id'],
        });
        userId = u?.id || null;
    }

    await WhatsappMessage.create({
        direction: 'in',
        user_id: userId,
        to_phone: '',                     // recebemos, então nosso número é destino — não relevante aqui
        from_phone: fromPhone,
        type: ['text','image','document','audio','video','interactive','button'].includes(type) ? type : 'unknown',
        body,
        media_url: mediaUrl,
        meta_message_id: m.id || null,
        status: 'received',
        raw_payload: m,
        sent_at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
    });
}

/**
 * Processa o body inteiro do webhook (já parseado).
 * Estrutura típica:
 *   { object: 'whatsapp_business_account', entry: [ { changes: [ { value: { ... } } ] } ] }
 */
async function processPayload(body) {
    const entries = Array.isArray(body?.entry) ? body.entry : [];

    for (const entry of entries) {
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change?.value || {};

            // statuses
            if (Array.isArray(value.statuses)) {
                for (const s of value.statuses) {
                    try { await handleStatusUpdate(s); }
                    catch (e) { console.error('[whatsapp/webhook] status err:', e?.message); }
                }
            }

            // mensagens recebidas
            if (Array.isArray(value.messages)) {
                for (const m of value.messages) {
                    const fromPhone = m.from || value.contacts?.[0]?.wa_id || null;
                    try { await handleIncomingMessage(m, fromPhone); }
                    catch (e) { console.error('[whatsapp/webhook] inbound err:', e?.message); }
                }
            }
        }
    }
}

export default {
    verifySignature,
    verifyHandshake,
    processPayload,
};
