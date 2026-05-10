// services/alerts/AlertEngine.js
//
// Motor que registra crons das alert_rules e dispara cada regra na hora certa.
//
// Boot:
//   - Lê todas as rules enabled+schedule e registra um cron pra cada
//   - Mantém um Map(ruleId → cronTask) pra poder reagendar/cancelar
//
// Quando uma rule muda (CRUD), chama-se reschedule(rule) ou unschedule(rule.id)
// e o engine atualiza os crons em runtime sem precisar reiniciar o server.
//
// Disparo (fire):
//   1. Re-executa o tool_call via AlertReportService.execute(rule, user)
//   2. Renderiza title/preview com Handlebars
//   3. Chama NotificationService.notify (in-app + e-mail conforme channels)
//   4. Pra WhatsApp: cria alert_pending_reply com state='awaiting_initial_reply'
//      e manda template alert_generic_v1; o relatório completo só vai depois
//      do user responder + confirmar (ver AlertReplyHandler)
//   5. Loga em alert_trigger_logs

import cron from 'node-cron';
import Handlebars from 'handlebars';
import dayjs from 'dayjs';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';
import WhatsAppTemplateService from '../whatsapp/WhatsAppTemplateService.js';
import AlertReportService from './AlertReportService.js';

const { AlertRule, AlertTriggerLog, AlertPendingReply, User, WhatsappMessage } = db;

// ─── Daily limit ─────────────────────────────────────────────────────────────

/**
 * Conta quantos disparos com status='success' o user já teve hoje
 * (somando todas as suas regras). Compara com user.daily_alert_limit.
 */
async function isOverDailyLimit(ownerUserId, dailyLimit) {
    if (!dailyLimit || dailyLimit <= 0) return false;
    const startOfDay = dayjs().startOf('day').toDate();
    const count = await AlertTriggerLog.count({
        where: {
            status: 'success',
            fired_at: { [Op.gte]: startOfDay },
        },
        include: [{
            model: AlertRule,
            as: 'rule',
            required: true,
            attributes: [],
            where: { owner_user_id: ownerUserId },
        }],
    });
    return count >= dailyLimit;
}

// Map: ruleId → ScheduledTask (instância do node-cron)
const _tasks = new Map();

// Cooldown enforcement
function isCooldown(rule) {
    if (!rule.cooldown_minutes || !rule.last_triggered_at) return false;
    const elapsedMin = (Date.now() - new Date(rule.last_triggered_at).getTime()) / 60_000;
    return elapsedMin < rule.cooldown_minutes;
}

// Render Handlebars com fallback seguro
function safeRender(template, ctx) {
    try { return Handlebars.compile(template || '')(ctx); }
    catch (e) {
        console.warn('[AlertEngine] template render falhou:', e?.message);
        return template || '';
    }
}

// ─── Disparo individual ──────────────────────────────────────────────────────

async function fire(ruleId, { force = false } = {}) {
    const rule = await AlertRule.findByPk(ruleId, {
        include: [{ model: User, as: 'owner', attributes: [
            'id', 'username', 'email', 'role', 'city', 'position', 'whatsapp_phone',
            'whatsapp_consent_at', 'whatsapp_consent_revoked_at', 'daily_alert_limit',
        ] }],
    });
    if (!rule) return;
    if (!rule.enabled && !force) return;

    if (!force && isCooldown(rule)) {
        await AlertTriggerLog.create({
            alert_rule_id: rule.id,
            status: 'suppressed_cooldown',
        });
        return;
    }

    const owner = rule.owner;
    if (!owner) {
        console.warn(`[AlertEngine] regra ${rule.id} sem owner válido — pulando.`);
        return;
    }

    // Daily limit (não bloqueia disparos forçados manualmente pelo admin/debug)
    if (!force && await isOverDailyLimit(owner.id, owner.daily_alert_limit)) {
        await AlertTriggerLog.create({
            alert_rule_id: rule.id,
            status: 'suppressed_daily_limit',
            tool_result_summary: `Limite diário de ${owner.daily_alert_limit} disparos atingido para ${owner.username}.`,
        });
        return;
    }

    // 1) Executa a tool
    const { preview, report, raw } = await AlertReportService.execute(rule, owner);

    // 2) Renderiza title/preview
    const ctx = {
        rule:    { name: rule.name },
        owner:   { username: owner.username, email: owner.email },
        result:  raw,
        preview, // preview gerado pela tool
        now:     dayjs().format('DD/MM/YYYY HH:mm'),
    };
    const title       = safeRender(rule.title_template,   ctx) || rule.name;
    const previewText = safeRender(rule.preview_template, ctx) || preview;

    const channels = rule.channels || { inapp: true, email: false, whatsapp: true };

    // 3) In-app + e-mail via NotificationService (recipients = só o owner)
    const notifyResult = await NotificationService.notify({
        type: NotificationType.GENERIC,    // tipo agnóstico — cada alerta é único
        recipients: { users: [owner.id] },
        title,
        body: previewText,
        data: { alert_rule_id: rule.id, source: 'alert' },
        importance: 6,
        channels: {
            inapp: !!channels.inapp,
            email: !!channels.email,
            whatsapp: false,                // WhatsApp tratado separado abaixo (fluxo 2 msgs)
        },
        emailData: {
            title,
            body: report,                   // no e-mail mandamos o relatório completo direto
        },
    }).catch(err => {
        console.error('[AlertEngine] notify falhou:', err?.message || err);
        return { inappCreated: 0, emailsSent: 0 };
    });

    let whatsappMsgId = null;

    // 4) WhatsApp: fluxo de 2 mensagens
    if (channels.whatsapp) {
        whatsappMsgId = await sendInitialAlert({ rule, owner, title, preview: previewText, report })
            .catch(err => { console.error('[AlertEngine] whatsapp falhou:', err?.message); return null; });
    }

    // 5) Atualiza contadores e loga
    await rule.update({
        last_triggered_at: new Date(),
        trigger_count: rule.trigger_count + 1,
    });

    await AlertTriggerLog.create({
        alert_rule_id: rule.id,
        status: 'success',
        tool_result_summary: previewText,
        whatsapp_message_id: whatsappMsgId,
    });
}

// ─── Envio do template inicial (alerta) + criação do pending reply ───────────

const ALERT_TEMPLATE_NAME = 'alert_generic_v1';
const ALERT_TEMPLATE_LANG = 'pt_BR';
const REPLY_WINDOW_HOURS  = 23; // 1h de margem da janela 24h

async function sendInitialAlert({ rule, owner, title, preview, report }) {
    if (!owner.whatsapp_phone) return null;
    const consented = !!owner.whatsapp_consent_at &&
        (!owner.whatsapp_consent_revoked_at ||
            new Date(owner.whatsapp_consent_at) > new Date(owner.whatsapp_consent_revoked_at));
    if (!consented) return null;

    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.has_access_token || !cfg?.phone_number_id) {
        console.warn('[AlertEngine] WhatsApp config incompleto — alerta não enviado.');
        return null;
    }

    // Variáveis do template alert_generic_v1: {{1}} = nome do user, {{2}} = título do alerta, {{3}} = resumo
    const variables = [
        owner.username || 'usuário',
        title,
        (preview || 'Relatório disponível').slice(0, 200),
    ];

    // Loga a mensagem como "queued" antes do send
    const baseMsg = {
        direction: 'out',
        user_id: owner.id,
        to_phone: owner.whatsapp_phone,
        type: 'template',
        template_name: ALERT_TEMPLATE_NAME,
        template_language: ALERT_TEMPLATE_LANG,
        variables,
        body: `${title} — ${preview}`,
    };

    // Dry-run
    if (!cfg.active || cfg.dry_run) {
        const m = await WhatsappMessage.create({ ...baseMsg, status: 'dry_run' });
        await createPendingReply({ rule, owner, log_id: null, report, wamid: null });
        return m.id;
    }

    // Verifica template aprovado
    const tpl = await WhatsAppTemplateService.findApproved(ALERT_TEMPLATE_NAME, ALERT_TEMPLATE_LANG);
    if (!tpl) {
        const m = await WhatsappMessage.create({
            ...baseMsg,
            status: 'failed',
            error_code: 'TEMPLATE_NOT_APPROVED',
            error_message: `Crie o template "${ALERT_TEMPLATE_NAME}" e sincronize.`,
            failed_at: new Date(),
        });
        return m.id;
    }

    try {
        const { id: wamid } = await WhatsAppService.sendTemplate({
            to: owner.whatsapp_phone,
            templateName: ALERT_TEMPLATE_NAME,
            language: ALERT_TEMPLATE_LANG,
            variables,
        });
        const m = await WhatsappMessage.create({
            ...baseMsg,
            status: 'sent',
            meta_message_id: wamid,
            sent_at: new Date(),
        });
        await createPendingReply({ rule, owner, log_id: null, report, wamid });
        return m.id;
    } catch (err) {
        const m = await WhatsappMessage.create({
            ...baseMsg,
            status: 'failed',
            error_code: err.code || 'SEND_ERROR',
            error_message: err.message,
            failed_at: new Date(),
        });
        return m.id;
    }
}

async function createPendingReply({ rule, owner, log_id, report, wamid }) {
    const expiresAt = new Date(Date.now() + REPLY_WINDOW_HOURS * 60 * 60 * 1000);
    return AlertPendingReply.create({
        alert_rule_id: rule.id,
        log_id,
        user_id: owner.id,
        phone: owner.whatsapp_phone,
        rule_name: rule.name,
        meta_message_id: wamid || null,
        state: 'awaiting_reply',
        report_payload: report,
        expires_at: expiresAt,
    });
}

// ─── Schedule registry ───────────────────────────────────────────────────────

function unschedule(ruleId) {
    const task = _tasks.get(ruleId);
    if (task) {
        try { task.stop(); } catch {}
        _tasks.delete(ruleId);
    }
}

function schedule(rule) {
    unschedule(rule.id);

    if (!rule.enabled || rule.trigger_type !== 'schedule' || !rule.cron) return;

    if (!cron.validate(rule.cron)) {
        console.warn(`[AlertEngine] cron inválido na regra ${rule.id}: "${rule.cron}"`);
        return;
    }

    const task = cron.schedule(rule.cron, () => {
        fire(rule.id).catch(err => {
            console.error(`[AlertEngine] fire ${rule.id} erro:`, err?.message || err);
        });
    }, {
        timezone: rule.timezone || 'America/Sao_Paulo',
    });

    _tasks.set(rule.id, task);
}

async function reschedule(ruleId) {
    const rule = await AlertRule.findByPk(ruleId);
    if (rule) schedule(rule);
}

// ─── Boot inicial ────────────────────────────────────────────────────────────

async function boot() {
    try {
        const rules = await AlertRule.findAll({ where: { enabled: true, trigger_type: 'schedule' } });
        for (const r of rules) schedule(r);
        console.log(`✅ AlertEngine iniciado com ${rules.length} regra(s) agendada(s).`);
    } catch (err) {
        console.error('[AlertEngine] falha no boot:', err?.message || err);
    }
}

function listScheduled() {
    return Array.from(_tasks.keys());
}

export default {
    boot,
    schedule,
    reschedule,
    unschedule,
    fire,
    listScheduled,
};
