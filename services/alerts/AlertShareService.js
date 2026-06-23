// services/alerts/AlertShareService.js
//
// Compartilhamento de alertas entre usuários.
//
//   createShare → cria o convite (alert_shares pending) e avisa o destinatário
//                 por in-app + e-mail (NotificationService) e, se configurado,
//                 por WhatsApp com template SIM/NÃO (automação 'alert_share').
//   respond     → accept clona a regra pro destinatário (cópia independente) e
//                 agenda no AlertEngine; decline só marca como recusado.
//   listIncoming→ convites pendentes (não expirados) do usuário.
//   getAdminStats→ visão geral pro painel admin.
//
// O WhatsApp degrada com segurança: só envia se a automação estiver habilitada,
// o template aprovado na Meta e o destinatário com opt-in ativo. Caso contrário,
// o convite continua valendo via tela + e-mail.

import { Op, fn, col } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../whatsapp/WhatsAppTemplateService.js';
import WhatsAppAutomationService from '../whatsapp/WhatsAppAutomationService.js';
import AlertEngine from './AlertEngine.js';

const { AlertShare, AlertRule, AlertTriggerLog, User, WhatsappMessage } = db;

const SHARE_TTL_DAYS = 7;
const SHARE_LANG = 'pt_BR';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasActiveConsent(u) {
    if (!u?.whatsapp_phone) return false;
    if (!u?.whatsapp_consent_at) return false;
    if (u?.whatsapp_consent_revoked_at &&
        new Date(u.whatsapp_consent_revoked_at) > new Date(u.whatsapp_consent_at)) return false;
    return true;
}

const DOW = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/**
 * Descreve um cron de 5 campos em português legível, pra mostrar a recorrência do
 * alerta no convite (ex.: "todo dia às 08:00", "toda segunda às 09:00",
 * "dia 1 de cada mês às 08:00"). Casos exóticos caem no próprio cron.
 */
export function describeCron(cron) {
    if (!cron) return 'conforme a agenda configurada';
    const parts = String(cron).trim().split(/\s+/);
    if (parts.length !== 5) return String(cron);
    const [min, hour, dom, mon, dow] = parts;
    const m = Number(min), h = Number(hour);
    if (Number.isNaN(m) || Number.isNaN(h) || mon !== '*') return String(cron);

    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (dom === '*' && dow === '*') return `todo dia às ${time}`;
    if (dom !== '*' && dow === '*') return `dia ${dom} de cada mês às ${time}`;
    if (dom === '*' && dow !== '*') {
        const nums = dow.split(',').map(d => Number(d) % 7).filter(n => !Number.isNaN(n));
        const days = nums.map(n => DOW[n]);
        if (!days.length) return `às ${time}`;
        if (days.length === 1) {
            // domingo (0) e sábado (6) são masculinos → "todo"; demais → "toda"
            const artigo = (nums[0] === 0 || nums[0] === 6) ? 'todo' : 'toda';
            return `${artigo} ${days[0]} às ${time}`;
        }
        return `${days.slice(0, -1).join(', ')} e ${days[days.length - 1]} às ${time}`;
    }
    return String(cron);
}

const PUBLIC_USER_ATTRS = [
    'id', 'username', 'email', 'whatsapp_phone',
    'whatsapp_consent_at', 'whatsapp_consent_revoked_at',
];

/**
 * Envia o template de convite via WhatsApp e retorna o wamid (ou null se não saiu).
 * Mirror do AlertEngine.sendInitialAlert, simplificado pra um único template.
 */
async function sendShareInvite({ share, toUser, fromUser, rule }) {
    if (!hasActiveConsent(toUser)) return null;

    const automation = await WhatsAppAutomationService.getByKey('alert_share').catch(() => null);
    if (automation && automation.enabled === false) return null;

    const templateName = automation?.templateName || 'alert_share_v1';
    const lang = automation?.templateLanguage || SHARE_LANG;

    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.has_access_token || !cfg?.phone_number_id) {
        console.warn('[AlertShare] WhatsApp config incompleto — convite não enviado por WhatsApp.');
        return null;
    }

    // {{1}} destinatário, {{2}} remetente, {{3}} nome do alerta, {{4}} recorrência
    const variables = [
        toUser.username || 'usuário',
        fromUser.username || 'um colega',
        (rule.name || 'alerta').slice(0, 200),
        describeCron(rule.cron),
    ];

    const baseMsg = {
        direction: 'out',
        user_id: toUser.id,
        to_phone: toUser.whatsapp_phone,
        type: 'template',
        template_name: templateName,
        template_language: lang,
        variables,
        body: `${fromUser.username} compartilhou o alerta "${rule.name}" (${describeCron(rule.cron)}) com você.`,
    };

    // Dry-run: registra sem chamar a API (sem wamid real).
    if (!cfg.active || cfg.dry_run) {
        await WhatsappMessage.create({ ...baseMsg, status: 'dry_run' });
        return null;
    }

    // Só envia se o template estiver APROVADO na Meta — senão registra falha e
    // segue (o convite continua valendo por tela + e-mail).
    const tpl = await WhatsAppTemplateService.findApproved(templateName, lang);
    if (!tpl) {
        await WhatsappMessage.create({
            ...baseMsg,
            status: 'failed',
            error_code: 'TEMPLATE_NOT_APPROVED',
            error_message: `Template "${templateName}" não está APPROVED. Crie e sincronize no portal.`,
            failed_at: new Date(),
        });
        return null;
    }

    try {
        const { id: wamid } = await WhatsAppService.sendTemplate({
            to: toUser.whatsapp_phone, templateName, language: lang, variables,
        });
        await WhatsappMessage.create({ ...baseMsg, status: 'sent', meta_message_id: wamid, sent_at: new Date() });
        return wamid;
    } catch (err) {
        await WhatsappMessage.create({
            ...baseMsg,
            status: 'failed',
            error_code: err.code || 'SEND_ERROR',
            error_message: err.message,
            failed_at: new Date(),
        });
        return null;
    }
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Cria um convite de compartilhamento e notifica o destinatário.
 * @returns {Promise<{share?:object, error?:string}>}
 */
export async function createShare({ rule, fromUser, toUserId, note = null, channels = {} }) {
    const targetId = Number(toUserId);
    if (!targetId || targetId === fromUser.id) return { error: 'invalid_target' };

    const toUser = await User.findByPk(targetId, { attributes: PUBLIC_USER_ATTRS });
    if (!toUser) return { error: 'target_not_found' };

    // Já é dono de uma cópia desse alerta? (clonado antes a partir da mesma origem)
    const alreadyOwns = await AlertShare.findOne({
        where: { alert_rule_id: rule.id, to_user_id: targetId, status: 'accepted' },
    });
    if (alreadyOwns) return { error: 'already_accepted' };

    // Convite pendente duplicado → reaproveita o existente (evita spam).
    const dupe = await AlertShare.findOne({
        where: { alert_rule_id: rule.id, to_user_id: targetId, status: 'pending', expires_at: { [Op.gt]: new Date() } },
    });
    if (dupe) return { error: 'already_pending' };

    const ch = {
        inapp:    channels.inapp !== false,
        email:    channels.email !== false,
        whatsapp: !!channels.whatsapp,
    };

    const share = await AlertShare.create({
        alert_rule_id: rule.id,
        from_user_id:  fromUser.id,
        to_user_id:    targetId,
        status:        'pending',
        note:          note ? String(note).slice(0, 1000) : null,
        channels:      ch,
        expires_at:    new Date(Date.now() + SHARE_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

    // 1) in-app + e-mail
    const recurrence = describeCron(rule.cron);
    const noteLine = note ? `<br><br>Mensagem de ${fromUser.username}: "${String(note).trim()}"` : '';
    await NotificationService.notify({
        type: NotificationType.ALERT_SHARED,
        recipients: { users: [targetId] },
        title: `${fromUser.username} compartilhou um alerta com você`,
        body: `"${rule.name}" (${recurrence}) - aceite na tela de Alertas para começar a receber.`,
        data: { share_id: share.id, alert_rule_id: rule.id, from_user_id: fromUser.id, source: 'alert_share' },
        link: '/settings/alerts',
        importance: 6,
        channels: { inapp: ch.inapp, email: ch.email, whatsapp: false },
        bypassPrefs: true,
        emailData: {
            title: `${fromUser.username} compartilhou um alerta com você`,
            preview: `Alerta "${rule.name}" · ${recurrence}`,
            bodyHtml: `${fromUser.username} quer compartilhar o alerta <strong>${rule.name}</strong> com você.`
                + `<br>Recorrência: <strong>${recurrence}</strong>.${noteLine}`
                + `<br><br>Abra a tela de <strong>Alertas</strong> no Menin Office para <strong>aceitar</strong> ou <strong>recusar</strong>. Ao aceitar, você passa a receber este alerta com sua própria cópia.`,
        },
    }).catch(err => console.error('[AlertShare] notify falhou:', err?.message || err));

    // 2) WhatsApp (best-effort, degrada com segurança)
    if (ch.whatsapp) {
        const wamid = await sendShareInvite({ share, toUser, fromUser, rule })
            .catch(err => { console.error('[AlertShare] whatsapp falhou:', err?.message); return null; });
        if (wamid) await share.update({ meta_message_id: wamid });
    }

    return { share };
}

/** Convites pendentes (não expirados) recebidos pelo usuário. */
export async function listIncoming(userId) {
    const rows = await AlertShare.findAll({
        where: { to_user_id: userId, status: 'pending', expires_at: { [Op.gt]: new Date() } },
        include: [
            { model: AlertRule, as: 'rule', attributes: ['id', 'name', 'description', 'cron', 'channels', 'tool_call'] },
            { model: User,      as: 'fromUser', attributes: ['id', 'username', 'email'] },
        ],
        order: [['created_at', 'DESC']],
        limit: 100,
    });
    return rows.map(r => {
        const obj = r.get({ plain: true });
        obj.recurrence = describeCron(obj.rule?.cron);
        return obj;
    });
}

/** Clona a regra original como cópia independente do destinatário e agenda. */
async function cloneRuleForUser(rule, toUserId, fromUserId) {
    const clone = await AlertRule.create({
        name:        rule.name,
        description: rule.description,
        owner_user_id:      toUserId,
        created_by_user_id: fromUserId,
        created_via_chat_session_id: null,
        trigger_type: rule.trigger_type,
        cron:         rule.cron,
        timezone:     rule.timezone,
        tool_call:        rule.tool_call,
        title_template:   rule.title_template,
        preview_template: rule.preview_template,
        channels:         rule.channels,
        cooldown_minutes: rule.cooldown_minutes,
        enabled: true,
    });
    try { AlertEngine.schedule(clone); }
    catch (err) { console.error('[AlertShare] schedule do clone falhou:', err?.message); }
    return clone;
}

/**
 * Aceita ou recusa um convite. Guarda: só o destinatário pode responder.
 * @returns {Promise<{ok?:true, status?:string, clonedRuleId?:number, error?:string}>}
 */
export async function respond({ shareId, user, action }) {
    const share = await AlertShare.findByPk(Number(shareId), {
        include: [{ model: AlertRule, as: 'rule' }],
    });
    if (!share) return { error: 'not_found' };
    if (share.to_user_id !== user.id) return { error: 'forbidden' };
    if (share.status !== 'pending') return { ok: true, status: share.status }; // idempotente

    if (action === 'decline') {
        await share.update({ status: 'declined', responded_at: new Date() });
        return { ok: true, status: 'declined' };
    }

    if (action === 'accept') {
        if (!share.rule) {
            // Regra original sumiu antes do aceite.
            await share.update({ status: 'expired', responded_at: new Date() });
            return { error: 'rule_gone' };
        }
        const clone = await cloneRuleForUser(share.rule, share.to_user_id, share.from_user_id);
        await share.update({ status: 'accepted', responded_at: new Date(), cloned_rule_id: clone.id });
        return { ok: true, status: 'accepted', clonedRuleId: clone.id };
    }

    return { error: 'invalid_action' };
}

/**
 * Resolve a resposta SIM/NÃO vinda do WhatsApp (chamado pelo AlertReplyHandler).
 * `verdict`: 'yes' (aceita) | 'no' (recusa).
 * @returns {Promise<{share:object, status:string}|null>}
 */
export async function respondFromWhatsApp({ share, verdict }) {
    const user = { id: share.to_user_id };
    const action = verdict === 'yes' ? 'accept' : 'decline';
    const res = await respond({ shareId: share.id, user, action });
    if (res.error) return null;
    return { share, status: res.status };
}

/** Visão geral pro painel admin. */
export async function getAdminStats() {
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const start7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rules = await AlertRule.findAll({
        attributes: ['id', 'owner_user_id', 'enabled', 'trigger_count', 'last_triggered_at'],
        raw: true,
    });

    const owners = new Map();   // owner_user_id → agregados
    const ruleOwner = new Map(); // rule_id → owner_user_id
    for (const r of rules) {
        ruleOwner.set(r.id, r.owner_user_id);
        const o = owners.get(r.owner_user_id) || { rulesCount: 0, enabledCount: 0, triggersTotal: 0, lastTriggeredAt: null };
        o.rulesCount++;
        if (r.enabled) o.enabledCount++;
        o.triggersTotal += (r.trigger_count || 0);
        if (r.last_triggered_at && (!o.lastTriggeredAt || new Date(r.last_triggered_at) > new Date(o.lastTriggeredAt))) {
            o.lastTriggeredAt = r.last_triggered_at;
        }
        owners.set(r.owner_user_id, o);
    }

    // Disparos com sucesso nos últimos 7 dias, por dono (via mapa rule→owner).
    const logs7d = await AlertTriggerLog.findAll({
        attributes: ['alert_rule_id'],
        where: { status: 'success', fired_at: { [Op.gte]: start7d } },
        raw: true,
    });
    const per7 = new Map();
    for (const l of logs7d) {
        const ow = ruleOwner.get(l.alert_rule_id);
        if (ow == null) continue;
        per7.set(ow, (per7.get(ow) || 0) + 1);
    }

    const triggersToday = await AlertTriggerLog.count({
        where: { status: 'success', fired_at: { [Op.gte]: startToday } },
    });

    const ownerIds = [...owners.keys()];
    const users = ownerIds.length
        ? await User.findAll({ where: { id: ownerIds }, attributes: ['id', 'username', 'email'], raw: true })
        : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    const perUser = ownerIds.map(id => ({
        user_id: id,
        username: userMap.get(id)?.username || `#${id}`,
        email: userMap.get(id)?.email || null,
        ...owners.get(id),
        triggers7d: per7.get(id) || 0,
    })).sort((a, b) => b.rulesCount - a.rulesCount || b.triggersTotal - a.triggersTotal);

    // Shares por status
    const sharesAgg = await AlertShare.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'], raw: true,
    });
    const shares = { pending: 0, accepted: 0, declined: 0, expired: 0 };
    for (const s of sharesAgg) shares[s.status] = Number(s.count);

    return {
        totals: {
            rules: rules.length,
            rulesEnabled: rules.filter(r => r.enabled).length,
            users: owners.size,
            triggersTotal: rules.reduce((s, r) => s + (r.trigger_count || 0), 0),
            triggersToday,
            triggers7d: logs7d.length,
        },
        shares,
        perUser,
    };
}

export default { createShare, listIncoming, respond, respondFromWhatsApp, getAdminStats };
