// services/emeAtende/EmeAtendeMessenger.js
// Camada de envio da Eme Atende COM persistência e dry_run PRÓPRIO (independente do
// dry_run do Office - a Eme Atende pode testar em sombra com as notificações ao vivo).
// O envio real usa o WhatsAppService do Office (mesmo número/token).

import db from '../../models/sequelize/index.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppWindowService from '../whatsapp/WhatsAppWindowService.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';
import { OPENER_FALLBACK_TEMPLATES, OPENER_VAR_FALLBACKS } from './emeAtendeOpenerTemplates.js';

// Janela de serviço da Cloud API: 24h desde a última mensagem do lead, com
// margem pra não disparar com ela fechando em trânsito (erro 131047).
const WINDOW_MS = 24 * 60 * 60 * 1000;
const SAFETY_MS = 5 * 60 * 1000;

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

/**
 * Trava de janela de 24h. Texto e mídia livres só valem enquanto a janela de
 * serviço está aberta; fora dela a Meta recusa com 131047 e a mensagem some.
 * Antes disso o erro só aparecia como linha `failed` sem explicação.
 *
 * Não há fallback pra template aqui de propósito: mandar template de
 * reengajamento é mensagem PAGA e decisão de produto, não de runtime.
 *
 * @returns {Promise<object|null>} linha persistida quando BLOQUEOU, null quando pode enviar.
 */
async function guardWindow(conversation, type, body) {
    try {
        // A fonte primária é a PRÓPRIA conversa: o inbound do lead é gravado em
        // eme_atende_messages, não em whatsapp_messages — então o
        // WhatsAppWindowService sozinho diria "fechada" sempre. Ele entra só
        // como segunda fonte, pro caso do lead ter escrito antes de virar lead
        // (aí o inbound ficou do lado do Office).
        let lastInbound = conversation.last_inbound_at ? new Date(conversation.last_inbound_at) : null;
        const office = await WhatsAppWindowService.getServiceWindow(conversation.phone).catch(() => null);
        if (office?.lastInboundAt) {
            const officeAt = new Date(office.lastInboundAt);
            if (!lastInbound || officeAt > lastInbound) lastInbound = officeAt;
        }

        const elapsed = lastInbound ? Date.now() - lastInbound.getTime() : Infinity;
        if (elapsed < WINDOW_MS - SAFETY_MS) return null;

        const detail = lastInbound
            ? `última mensagem do lead em ${lastInbound.toISOString()}`
            : 'nenhuma mensagem do lead registrada';
        console.warn(`[eme-atende/messenger] janela de 24h FECHADA pra ${conversation.phone} — envio cancelado (${detail}).`);
        return persistOut({
            conversation, type, body,
            status: 'skipped',
            error: `Janela de 24h fechada (${detail}). Só template aprovado alcança o lead agora.`,
        });
    } catch (err) {
        // Falha ao consultar a janela não pode bloquear o atendimento: segue e
        // deixa a Meta decidir (o erro real fica registrado no envio).
        console.warn('[eme-atende/messenger] checagem de janela falhou, seguindo:', err?.message);
        return null;
    }
}

/** Texto livre - só dentro da janela de 24h após msg do lead. */
async function sendText({ conversation, body }) {
    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active || cfg.dry_run) {
        console.log(`[eme-atende/messenger] DRY_RUN text → ${conversation.phone}: "${String(body).slice(0, 120)}"`);
        return persistOut({ conversation, type: 'text', body, status: 'dry_run' });
    }
    const win = await guardWindow(conversation, 'text', body);
    if (win) return win;
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
    const win = await guardWindow(conversation, 'image', body);
    if (win) return win;
    try {
        const { id } = await WhatsAppService.sendImage({ to: conversation.phone, link: url, caption });
        return persistOut({ conversation, type: 'image', body, wamid: id, status: 'sent' });
    } catch (err) {
        console.error(`[eme-atende/messenger] imagem falhou pra ${conversation.phone}:`, err?.message);
        return persistOut({ conversation, type: 'image', body, status: 'failed', error: err?.message });
    }
}

/**
 * Documento (hoje: o book em PDF do empreendimento, vindo do site).
 * Mesma regra da imagem: a Meta BAIXA o arquivo pela URL, então ela precisa ser
 * pública. Link do SharePoint ou de storage privado falha do lado deles.
 */
async function sendDocument({ conversation, url, filename = null, caption = null, label = null }) {
    const body = `[documento${label ? `: ${label}` : ''}] ${url}`;
    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active || cfg.dry_run) {
        console.log(`[eme-atende/messenger] DRY_RUN documento → ${conversation.phone}: ${body}`);
        return persistOut({ conversation, type: 'document', body, status: 'dry_run' });
    }
    const win = await guardWindow(conversation, 'document', body);
    if (win) return win;
    try {
        const { id } = await WhatsAppService.sendDocument({
            to: conversation.phone, link: url, filename: filename || 'material.pdf', caption,
        });
        return persistOut({ conversation, type: 'document', body, wamid: id, status: 'sent' });
    } catch (err) {
        console.error(`[eme-atende/messenger] documento falhou pra ${conversation.phone}:`, err?.message);
        return persistOut({ conversation, type: 'document', body, status: 'failed', error: err?.message });
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

    const language = flow.opener_language || 'pt_BR';

    // valida contra o cache local de templates (sync na tela do WhatsApp)
    const approved = async (name) => {
        const tpl = await db.WhatsappTemplate.findOne({ where: { name, language } });
        return { known: !!tpl, ok: !tpl || String(tpl.status).toUpperCase() === 'APPROVED', status: tpl?.status };
    };

    let templateName = flow.opener_template;
    try {
        const { ok, status } = await approved(templateName);
        if (!ok) {
            await logEvent(lead.id, conversation.id, 'opener_failed', {
                template: templateName, reason: `template status ${status} (não APPROVED)`,
            });
            return null;
        }
    } catch (err) {
        console.warn('[eme-atende/messenger] validação de template pulada:', err?.message);
    }

    // Campo vazio do lead não pode virar "-": a primeira mensagem chegaria como
    // "interesse no -". Antes de recorrer a texto neutro no meio da frase, troca
    // o template inteiro pelo equivalente SEM variável - só serve se aprovado.
    const fields = Array.isArray(flow.opener_variables) ? flow.opener_variables : [];
    const missing = [];
    let variables = fields.map(f => {
        const v = lead[f] !== undefined && lead[f] !== null ? lead[f] : lead.payload?.[f];
        if (v === undefined || v === null || v === '') {
            missing.push(f);
            return OPENER_VAR_FALLBACKS[f] || 'tudo bem';
        }
        return String(v);
    });
    if (missing.length) {
        const alt = OPENER_FALLBACK_TEMPLATES[templateName];
        let swapped = false;
        if (alt) {
            try {
                const { known, ok } = await approved(alt);
                if (known && ok) { templateName = alt; variables = []; swapped = true; }
            } catch (err) {
                console.warn('[eme-atende/messenger] substituto de abertura não checado:', err?.message);
            }
        }
        console.warn(`[eme-atende/messenger] lead ${lead.id} sem ${missing.join(', ')} — abertura ${swapped ? `trocada por ${templateName}` : 'usou texto neutro'}.`);
        await logEvent(lead.id, conversation.id, 'opener_missing_vars', {
            fields: missing, fallback_template: swapped ? templateName : null,
        });
    }

    const body = `[template:${templateName}] vars=${JSON.stringify(variables)}`;
    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active || cfg.dry_run) {
        console.log(`[eme-atende/messenger] DRY_RUN opener → ${conversation.phone}: ${body}`);
        const msg = await persistOut({ conversation, type: 'template', body, status: 'dry_run' });
        await logEvent(lead.id, conversation.id, 'opener_sent', { dry_run: true, template: templateName, variables });
        return msg;
    }
    try {
        const { id } = await WhatsAppService.sendTemplate({
            to: conversation.phone,
            templateName,
            language,
            variables,
        });
        const msg = await persistOut({ conversation, type: 'template', body, wamid: id, status: 'sent' });
        await logEvent(lead.id, conversation.id, 'opener_sent', { template: templateName, variables, wamid: id });
        return msg;
    } catch (err) {
        console.error(`[eme-atende/messenger] opener falhou pra ${conversation.phone}:`, err?.message);
        const msg = await persistOut({ conversation, type: 'template', body, status: 'failed', error: err?.message });
        await logEvent(lead.id, conversation.id, 'opener_failed', { template: templateName, error: err?.message });
        return msg;
    }
}

export default { sendText, sendImage, sendDocument, sendOpener, logEvent };
