// services/emeAtende/EmeAtendeMessenger.js
// Camada de envio da Eme Atende COM persistência e dry_run PRÓPRIO (independente do
// dry_run do Office - a Eme Atende pode testar em sombra com as notificações ao vivo).
// O envio real usa o WhatsAppService do Office (mesmo número/token).

import db from '../../models/sequelize/index.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';

async function logEvent(lead_id, conversation_id, type, detail = {}) {
    try { await db.EmeAtendeEvent.create({ lead_id, conversation_id, type, detail }); }
    catch (err) { console.error('[eme-atende/event]', err?.message); }
}

async function persistOut({ conversation, type, body, wamid = null, status, error = null, raw = null }) {
    const msg = await db.EmeAtendeMessage.create({
        conversation_id: conversation.id,
        direction: 'out',
        type,
        body,
        wamid,
        status,
        error_message: error,
        raw,
    });
    if (status === 'sent' || status === 'dry_run') {
        await conversation.update({ last_outbound_at: new Date() });
    }
    return msg;
}

/** Texto livre - só dentro da janela de 24h após msg do lead. */
async function sendText({ conversation, body }) {
    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active || cfg.dry_run) {
        console.log(`[eme-atende/messenger] DRY_RUN text → ${conversation.phone}: "${String(body).slice(0, 120)}"`);
        return persistOut({ conversation, type: 'text', body, status: 'dry_run' });
    }
    try {
        const { id } = await WhatsAppService.sendText({ to: conversation.phone, body });
        return persistOut({ conversation, type: 'text', body, wamid: id, status: 'sent' });
    } catch (err) {
        console.error(`[eme-atende/messenger] envio falhou pra ${conversation.phone}:`, err?.message);
        return persistOut({ conversation, type: 'text', body, status: 'failed', error: err?.message });
    }
}

/** Imagem por URL pública (tool enviar_imagem) - mesma janela de 24h do texto. */
async function sendImage({ conversation, url, caption = null, label = null }) {
    const body = `[imagem${label ? `: ${label}` : ''}] ${url}`;
    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active || cfg.dry_run) {
        console.log(`[eme-atende/messenger] DRY_RUN image → ${conversation.phone}: ${body}`);
        return persistOut({ conversation, type: 'image', body, status: 'dry_run' });
    }
    try {
        const { id } = await WhatsAppService.sendImage({ to: conversation.phone, link: url, caption });
        return persistOut({ conversation, type: 'image', body, wamid: id, status: 'sent' });
    } catch (err) {
        console.error(`[eme-atende/messenger] imagem falhou pra ${conversation.phone}:`, err?.message);
        return persistOut({ conversation, type: 'image', body, status: 'failed', error: err?.message });
    }
}

/**
 * Abertura de conversa: template aprovado (validado no cache whatsapp_templates
 * do Office - mesma WABA), variáveis vindas dos campos do lead.
 */
async function sendOpener({ lead, conversation, flow }) {
    if (!flow?.opener_template) {
        await logEvent(lead.id, conversation.id, 'opener_skipped', { reason: 'fluxo sem opener_template' });
        return null;
    }

    // valida contra o cache local de templates (sync na tela do WhatsApp)
    try {
        const tpl = await db.WhatsappTemplate.findOne({
            where: { name: flow.opener_template, language: flow.opener_language || 'pt_BR' },
        });
        if (tpl && String(tpl.status).toUpperCase() !== 'APPROVED') {
            await logEvent(lead.id, conversation.id, 'opener_failed', {
                template: flow.opener_template, reason: `template status ${tpl.status} (não APPROVED)`,
            });
            return null;
        }
    } catch (err) {
        console.warn('[eme-atende/messenger] validação de template pulada:', err?.message);
    }

    const fields = Array.isArray(flow.opener_variables) ? flow.opener_variables : [];
    const variables = fields.map(f => {
        const v = lead[f] !== undefined && lead[f] !== null ? lead[f] : lead.payload?.[f];
        return v === undefined || v === null || v === '' ? '-' : String(v);
    });

    const body = `[template:${flow.opener_template}] vars=${JSON.stringify(variables)}`;
    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active || cfg.dry_run) {
        console.log(`[eme-atende/messenger] DRY_RUN opener → ${conversation.phone}: ${body}`);
        const msg = await persistOut({ conversation, type: 'template', body, status: 'dry_run' });
        await logEvent(lead.id, conversation.id, 'opener_sent', { dry_run: true, template: flow.opener_template, variables });
        return msg;
    }
    try {
        const { id } = await WhatsAppService.sendTemplate({
            to: conversation.phone,
            templateName: flow.opener_template,
            language: flow.opener_language || 'pt_BR',
            variables,
        });
        const msg = await persistOut({ conversation, type: 'template', body, wamid: id, status: 'sent' });
        await logEvent(lead.id, conversation.id, 'opener_sent', { template: flow.opener_template, variables, wamid: id });
        return msg;
    } catch (err) {
        console.error(`[eme-atende/messenger] opener falhou pra ${conversation.phone}:`, err?.message);
        const msg = await persistOut({ conversation, type: 'template', body, status: 'failed', error: err?.message });
        await logEvent(lead.id, conversation.id, 'opener_failed', { template: flow.opener_template, error: err?.message });
        return msg;
    }
}

export default { sendText, sendImage, sendOpener, logEvent };
