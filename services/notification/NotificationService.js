// services/notification/NotificationService.js
//
// Ponto único para disparar notificações. Resolve destinatários (users / cargos /
// e-mails externos), respeita as preferências por tipo, persiste a notificação
// in-app por usuário e dispara nos canais configurados (in-app, e-mail, WhatsApp).
//
// Uso típico:
//   await NotificationService.notify({
//     type: NotificationType.EVENT_CREATED,
//     recipients: { users: [1,2], positions: ['Diretor'], emails: ['x@y.com'] },
//     title: `Novo evento: ${event.title}`,
//     body:  event.description,
//     data:  { eventId: event.id, image: event.images?.[0] },
//     link:  `/marketing/Events?search=${encodeURIComponent(event.title)}`,
//     importance: 7,
//     emailData:    { ... payload pro template Handlebars ... },   // opcional
//     whatsappData: { userName, title, eventDateFormatted, ... },  // opcional (default = data + emailData)
//   });

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { sendEmail } from '../../email/email.service.js';
import { getCatalogEntry, NotificationType } from './notificationTypes.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../whatsapp/WhatsAppTemplateService.js';

const { Notification, NotificationPreference, User, WhatsappMessage } = db;

// ───────────────────────────────────────────────────────────────────────────────
// Resolução de destinatários
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Resolve { users:[id], positions:[label], emails:[external] } em duas listas:
 *  - internalUsers: [{ id, email, username, whatsapp_phone, whatsapp_consent_at, whatsapp_consent_revoked_at }]
 *  - externalEmails: [string]
 */
async function resolveRecipients({ users = [], positions = [], emails = [] } = {}) {
    const userMap = new Map();
    const externalSet = new Set();

    const userAttrs = ['id', 'email', 'username', 'whatsapp_phone', 'whatsapp_consent_at', 'whatsapp_consent_revoked_at'];

    if (Array.isArray(users) && users.length) {
        const rows = await User.findAll({
            where: { id: users, status: true },
            attributes: userAttrs,
        });
        rows.forEach(u => userMap.set(u.id, u.get({ plain: true })));
    }

    if (Array.isArray(positions) && positions.length) {
        const rows = await User.findAll({
            where: { position: { [Op.in]: positions }, status: true },
            attributes: userAttrs,
        });
        rows.forEach(u => userMap.set(u.id, u.get({ plain: true })));
    }

    if (Array.isArray(emails) && emails.length) {
        const internalEmails = new Set(
            Array.from(userMap.values()).map(u => (u.email || '').toLowerCase())
        );
        for (const raw of emails) {
            const e = String(raw || '').trim().toLowerCase();
            if (!e) continue;
            if (internalEmails.has(e)) continue;
            externalSet.add(e);
        }
    }

    return {
        internalUsers: Array.from(userMap.values()),
        externalEmails: Array.from(externalSet),
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// Preferências
// ───────────────────────────────────────────────────────────────────────────────

async function loadPrefsForUsers(userIds, type) {
    if (!userIds.length) return new Map();
    const rows = await NotificationPreference.findAll({
        where: { user_id: userIds, type },
        attributes: ['user_id', 'inapp', 'email', 'whatsapp'],
    });
    return new Map(rows.map(r => [r.user_id, {
        inapp: !!r.inapp, email: !!r.email, whatsapp: !!r.whatsapp,
    }]));
}

function effectivePref(stored, defaults, channels) {
    const base = stored || defaults || { inapp: true, email: true, whatsapp: false };
    return {
        inapp:    !!(channels.inapp    && base.inapp),
        email:    !!(channels.email    && base.email),
        whatsapp: !!(channels.whatsapp && base.whatsapp),
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// WhatsApp
// ───────────────────────────────────────────────────────────────────────────────

function userHasActiveConsent(u) {
    if (!u?.whatsapp_phone) return false;
    if (!u?.whatsapp_consent_at) return false;
    if (u?.whatsapp_consent_revoked_at) {
        const consent = new Date(u.whatsapp_consent_at).getTime();
        const revoked = new Date(u.whatsapp_consent_revoked_at).getTime();
        if (revoked > consent) return false;
    }
    return true;
}

function pickVariables(spec, ctx) {
    if (!Array.isArray(spec?.variables)) return [];
    return spec.variables.map(key => {
        const v = ctx[key];
        return v === undefined || v === null ? '' : String(v);
    });
}

async function dispatchWhatsApp({ user, type, title, body, link, notificationId, whatsappSpec, ctx }) {
    if (!whatsappSpec) return null;

    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    const variables = pickVariables(whatsappSpec, ctx);

    // log da mensagem (queued/dry_run); status mudará via webhook
    const baseMsg = {
        direction: 'out',
        notification_id: notificationId || null,
        user_id: user.id,
        to_phone: user.whatsapp_phone,
        type: 'template',
        template_name: whatsappSpec.template,
        template_language: whatsappSpec.language || 'pt_BR',
        variables,
        body: title + (body ? ` — ${body}` : ''),
    };

    // dry-run: registra como dry_run e não chama API
    if (!cfg?.active || cfg?.dry_run) {
        return WhatsappMessage.create({ ...baseMsg, status: 'dry_run' });
    }

    // valida template
    const tpl = await WhatsAppTemplateService.findApproved(whatsappSpec.template, whatsappSpec.language || 'pt_BR');
    if (!tpl) {
        return WhatsappMessage.create({
            ...baseMsg,
            status: 'failed',
            error_code: 'TEMPLATE_NOT_APPROVED',
            error_message: `Template "${whatsappSpec.template}" não está APPROVED localmente. Sincronize com a Meta.`,
            failed_at: new Date(),
        });
    }
    if (tpl.variables_count > variables.length) {
        return WhatsappMessage.create({
            ...baseMsg,
            status: 'failed',
            error_code: 'VARIABLES_MISMATCH',
            error_message: `Template requer ${tpl.variables_count} variáveis; recebeu ${variables.length}.`,
            failed_at: new Date(),
        });
    }

    try {
        const { id } = await WhatsAppService.sendTemplate({
            to: user.whatsapp_phone,
            templateName: whatsappSpec.template,
            language: whatsappSpec.language || 'pt_BR',
            variables,
        });
        return WhatsappMessage.create({
            ...baseMsg,
            status: 'sent',
            meta_message_id: id,
            sent_at: new Date(),
        });
    } catch (err) {
        return WhatsappMessage.create({
            ...baseMsg,
            status: 'failed',
            error_code: err.code || 'SEND_ERROR',
            error_message: err.message || 'Falha no envio',
            failed_at: new Date(),
        });
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// API pública
// ───────────────────────────────────────────────────────────────────────────────

async function notify({
    type,
    recipients = {},
    title,
    body = null,
    data = {},
    link = null,
    importance = 5,
    channels = { inapp: true, email: true, whatsapp: true },
    emailData = null,
    whatsappData = null,
    expiresAt = null,
    bypassPrefs = false,    // se true, ignora preferências/defaults do user — usa channels diretamente
} = {}) {
    if (!type) throw new Error('NotificationService.notify: "type" é obrigatório.');
    if (!title) throw new Error('NotificationService.notify: "title" é obrigatório.');

    const catalog = getCatalogEntry(type);
    if (!catalog) {
        console.warn(`[notify] tipo "${type}" não está no catálogo. Crie em notificationTypes.js para aparecer nas preferências.`);
    }
    const defaults  = catalog?.defaults  || { inapp: true, email: true, whatsapp: false };
    const emailType = catalog?.emailType || null;
    const whatsappSpec = catalog?.whatsapp || null;

    const { internalUsers, externalEmails } = await resolveRecipients(recipients);

    let inappCreated = 0;
    let whatsappQueued = 0;
    const emailRecipients = new Set();
    const wppContext = { ...(data || {}), ...(emailData || {}), ...(whatsappData || {}) };

    if (internalUsers.length) {
        const userIds = internalUsers.map(u => u.id);
        const prefMap = bypassPrefs ? new Map() : await loadPrefsForUsers(userIds, type);

        for (const u of internalUsers) {
            // Quando bypassPrefs=true, usa os channels diretamente — sem AND com prefs/defaults.
            // Útil pra alertas onde o user já escolheu os canais ao criar a regra.
            const pref = bypassPrefs
                ? {
                    inapp:    !!channels.inapp,
                    email:    !!channels.email,
                    whatsapp: !!channels.whatsapp,
                }
                : effectivePref(prefMap.get(u.id), defaults, channels);

            // 1) in-app (cria a row)
            let createdNotif = null;
            if (pref.inapp) {
                try {
                    createdNotif = await Notification.create({
                        user_id: u.id,
                        type,
                        title,
                        body,
                        data,
                        link,
                        importance,
                        channel_inapp: true,
                        channel_email: pref.email && !!emailType,
                        channel_whatsapp: pref.whatsapp && !!whatsappSpec && userHasActiveConsent(u),
                        expires_at: expiresAt,
                    });
                    inappCreated++;
                    console.log(`[notify ${type}] in-app criado #${createdNotif.id} pra user ${u.id} ("${u.username}")`);
                } catch (err) {
                    console.error(`[notify ${type}] FALHA ao criar in-app pra user ${u.id}:`, err?.message || err);
                }
            } else {
                console.log(`[notify ${type}] in-app pulado pra user ${u.id} — pref.inapp=false (bypass=${bypassPrefs})`);
            }

            // 2) e-mail (acumula pra envio em lote)
            if (pref.email && emailType && u.email) {
                emailRecipients.add(u.email.toLowerCase());
            }

            // 3) whatsapp (envia individual — template + variáveis por user)
            const hasConsent = userHasActiveConsent(u);
            if (pref.whatsapp && whatsappSpec && hasConsent) {
                const ctx = { ...wppContext, userName: u.username || '', email: u.email || '' };
                try {
                    const msg = await dispatchWhatsApp({
                        user: u,
                        type,
                        title,
                        body,
                        link,
                        notificationId: createdNotif?.id || null,
                        whatsappSpec,
                        ctx,
                    });
                    if (msg) whatsappQueued++;
                } catch (err) {
                    console.error(`[notify] whatsapp falhou para user ${u.id}:`, err?.message || err);
                }
            } else {
                // Log de diagnóstico — só quando o catálogo TEM template mas algo bloqueou
                if (whatsappSpec) {
                    const reasons = [];
                    if (!pref.whatsapp) reasons.push('preferência whatsapp OFF');
                    if (!hasConsent) {
                        if (!u.whatsapp_phone) reasons.push('sem whatsapp_phone');
                        else if (!u.whatsapp_consent_at) reasons.push('sem whatsapp_consent_at (opt-in)');
                        else if (u.whatsapp_consent_revoked_at &&
                            new Date(u.whatsapp_consent_revoked_at) > new Date(u.whatsapp_consent_at)) {
                            reasons.push('opt-in revogado');
                        }
                    }
                    console.log(
                        `[notify ${type}] whatsapp pulado para user ${u.id} (${u.username}): ${reasons.join(', ')}`
                    );
                }
            }
        }
    }

    // externos: só e-mail
    if (channels.email && emailType) {
        for (const e of externalEmails) emailRecipients.add(e);
    }

    // dispara e-mail (uma vez para a lista toda)
    let emailsSent = 0;
    if (emailType && emailRecipients.size) {
        const list = Array.from(emailRecipients);
        const payload = emailData || { title, body, ...data };
        try {
            await sendEmail(emailType, list, payload);
            emailsSent = list.length;
        } catch (err) {
            console.error(`[notify] falha ao enviar e-mail (${type}):`, err?.message || err);
        }
    }

    return { inappCreated, emailsSent, whatsappQueued };
}

// ───────────────────────────────────────────────────────────────────────────────
// Listagem / leitura para o sino
// ───────────────────────────────────────────────────────────────────────────────

async function listForUser(userId, { unreadOnly = false, limit = 30, offset = 0 } = {}) {
    const where = { user_id: userId };
    if (unreadOnly) where.read_at = { [Op.is]: null };

    where[Op.and] = [{
        [Op.or]: [
            { expires_at: { [Op.is]: null } },
            { expires_at: { [Op.gt]: new Date() } },
        ],
    }];

    const { rows, count } = await Notification.findAndCountAll({
        where,
        order: [['read_at', 'ASC'], ['importance', 'DESC'], ['created_at', 'DESC']],
        limit,
        offset,
    });

    return { items: rows.map(r => r.get({ plain: true })), total: count };
}

async function unreadCount(userId) {
    return Notification.count({
        where: {
            user_id: userId,
            read_at: { [Op.is]: null },
            [Op.or]: [
                { expires_at: { [Op.is]: null } },
                { expires_at: { [Op.gt]: new Date() } },
            ],
        },
    });
}

async function markRead(userId, id) {
    const [updated] = await Notification.update(
        { read_at: new Date() },
        { where: { id, user_id: userId, read_at: { [Op.is]: null } } }
    );
    return updated > 0;
}

async function markAllRead(userId) {
    const [updated] = await Notification.update(
        { read_at: new Date() },
        { where: { user_id: userId, read_at: { [Op.is]: null } } }
    );
    return updated;
}

async function removeOne(userId, id) {
    return Notification.destroy({ where: { id, user_id: userId } });
}

// ───────────────────────────────────────────────────────────────────────────────
// Preferências
// ───────────────────────────────────────────────────────────────────────────────

async function getPreferences(userId) {
    const rows = await NotificationPreference.findAll({
        where: { user_id: userId },
        attributes: ['type', 'inapp', 'email', 'whatsapp'],
    });
    return rows.map(r => r.get({ plain: true }));
}

async function setPreference(userId, type, { inapp, email, whatsapp }) {
    if (!type) throw new Error('type é obrigatório');
    const [row, created] = await NotificationPreference.findOrCreate({
        where: { user_id: userId, type },
        defaults: {
            user_id: userId, type,
            inapp: !!inapp, email: !!email, whatsapp: !!whatsapp,
        },
    });
    if (!created) {
        if (typeof inapp === 'boolean') row.inapp = inapp;
        if (typeof email === 'boolean') row.email = email;
        if (typeof whatsapp === 'boolean') row.whatsapp = whatsapp;
        await row.save();
    }
    return row.get({ plain: true });
}

export default {
    notify,
    listForUser,
    unreadCount,
    markRead,
    markAllRead,
    removeOne,
    getPreferences,
    setPreference,
    NotificationType,
};
