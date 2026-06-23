// services/checklist/cobrancaService.js
// Motor de cobrança CONFIGURÁVEL (régua). Avalia as regras ativas contra as
// tarefas com prazo e dispara lembretes pelos canais configurados, com dedupe
// diário. Settings e regras são 100% editáveis pela tela admin.
import { Op } from 'sequelize';
import dayjs from 'dayjs';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { loadStatusMap, logActivity } from './lib.js';

// ── Helpers de data/fuso (sem plugin de timezone) ─────────────────────────────
function todayInTz(tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch { return new Date().toISOString().slice(0, 10); }
}
function hourInTz(tz) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(new Date());
        return Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    } catch { return new Date().getHours(); }
}
function dowOf(dateStr) {
    return new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0 dom ... 6 sáb
}

// ── Settings ──────────────────────────────────────────────────────────────────
export async function getSettings() {
    let s = await db.ChecklistSettings.findOne({ order: [['id', 'ASC']] });
    if (!s) s = await db.ChecklistSettings.create({});
    return s.get({ plain: true });
}

export async function updateSettings({ payload = {}, userId }) {
    let s = await db.ChecklistSettings.findOne({ order: [['id', 'ASC']] });
    if (!s) s = await db.ChecklistSettings.create({});
    for (const f of ['cobranca_enabled', 'run_hour', 'timezone', 'include_weekends', 'respect_user_prefs']) {
        if (f in payload) s[f] = payload[f];
    }
    s.updated_by = userId || null;
    await s.save();
    return s.get({ plain: true });
}

// ── Regras (régua) ────────────────────────────────────────────────────────────
const RULE_FIELDS = ['scope', 'scope_id', 'name', 'anchor', 'offset_days', 'repeat_every_days', 'max_occurrences', 'apply_states', 'recipients', 'channels', 'title_template', 'body_template', 'importance', 'active', 'position'];

export async function listRules() {
    const rows = await db.ChecklistReminderRule.findAll({ order: [['position', 'ASC'], ['offset_days', 'ASC'], ['id', 'ASC']] });
    return rows.map((r) => r.get({ plain: true }));
}

export async function createRule({ payload = {}, userId }) {
    if (!payload.name) throw new Error('Nome da regra é obrigatório.');
    const data = { created_by: userId || null, updated_by: userId || null };
    for (const f of RULE_FIELDS) if (f in payload) data[f] = payload[f];
    const row = await db.ChecklistReminderRule.create(data);
    return row.get({ plain: true });
}

export async function updateRule({ id, payload = {}, userId }) {
    const row = await db.ChecklistReminderRule.findByPk(Number(id));
    if (!row) throw new Error('Regra não encontrada.');
    for (const f of RULE_FIELDS) if (f in payload) row[f] = payload[f];
    row.updated_by = userId || null;
    await row.save();
    return row.get({ plain: true });
}

export async function removeRule({ id }) {
    const row = await db.ChecklistReminderRule.findByPk(Number(id));
    if (!row) throw new Error('Regra não encontrada.');
    await row.destroy();
    return { ok: true };
}

// ── Avaliação ─────────────────────────────────────────────────────────────────
function ruleAppliesTo(rule, checklist) {
    const mode = checklist.reminder_mode || 'DEFAULT';
    if (mode === 'OFF') return false;
    // CUSTOM: só a régua própria do checklist.
    if (mode === 'CUSTOM') return rule.scope === 'CHECKLIST' && rule.scope_id === checklist.id;
    // DEFAULT: régua compartilhada (global + por template); ignora regras específicas de checklist.
    if (rule.scope === 'GLOBAL') return true;
    if (rule.scope === 'TEMPLATE') return !!rule.scope_id && checklist.template_id === rule.scope_id;
    return false;
}

function anchorDate(rule, task) {
    return rule.anchor === 'CONTRACTED_AT' ? task.contracted_at : task.due_date;
}

function shouldFireToday(rule, anchor, today) {
    if (!anchor) return false;
    const base = dayjs(anchor).add(Number(rule.offset_days) || 0, 'day').format('YYYY-MM-DD');
    if (!rule.repeat_every_days) return today === base;
    if (today < base) return false;
    const diff = dayjs(today).diff(dayjs(base), 'day');
    if (diff % Number(rule.repeat_every_days) !== 0) return false;
    if (rule.max_occurrences) {
        const occ = diff / Number(rule.repeat_every_days) + 1;
        if (occ > Number(rule.max_occurrences)) return false;
    }
    return true;
}

function resolveRecipients(rule, task, checklist) {
    const users = new Set();
    const positions = new Set();
    const r = rule.recipients || {};
    if (r.assignee && task.assignee_user_id) users.add(task.assignee_user_id);
    if (r.owner && checklist.owner_user_id) users.add(checklist.owner_user_id);
    (r.user_ids || []).forEach((id) => { if (id) users.add(Number(id)); });
    (r.roles || []).forEach((p) => { if (p) positions.add(p); });
    return { users: [...users], positions: [...positions] };
}

function buildCtx(task, checklist, today) {
    const daysLate = task.due_date && today > task.due_date ? dayjs(today).diff(dayjs(task.due_date), 'day') : 0;
    const daysToDue = task.due_date ? dayjs(task.due_date).diff(dayjs(today), 'day') : 0;
    return {
        task: task.title,
        checklist: checklist.title,
        due: task.due_date ? dayjs(task.due_date).format('DD/MM/YYYY') : '',
        daysLate, daysToDue,
        assignee: task.assignee_label || '',
    };
}
function render(tpl, ctx) {
    if (!tpl) return '';
    return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (ctx[k] !== undefined ? String(ctx[k]) : ''));
}

async function dispatch({ rule, task, checklist, recipients, title, body, settings }) {
    const type = Number(rule.offset_days) > 0 ? NotificationType.CHECKLIST_TASK_OVERDUE : NotificationType.CHECKLIST_TASK_DUE_SOON;
    await NotificationService.notify({
        type,
        recipients,
        title: title || (Number(rule.offset_days) > 0 ? `Em atraso: ${task.title}` : `Lembrete: ${task.title}`),
        body: body || checklist.title,
        data: { checklistId: checklist.id, taskId: task.id, ruleId: rule.id },
        link: `/checklists/${checklist.id}?task=${task.id}`,
        importance: rule.importance || 6,
        channels: rule.channels || { inapp: true, email: true, whatsapp: false },
        bypassPrefs: !settings.respect_user_prefs,
        whatsappData: {
            userName: task.assignee_label || '',
            taskTitle: task.title,
            checklistTitle: checklist.title,
            dueDateFormatted: task.due_date ? dayjs(task.due_date).format('DD/MM/YYYY') : '',
        },
    });
}

// Executa a régua. dryRun=true só simula (retorna o que seria enviado).
// force=true ignora enabled/fim de semana (para teste manual).
export async function runEngine({ dryRun = false, force = false } = {}) {
    const settings = await getSettings();
    if (!settings.cobranca_enabled && !force) return { skipped: 'disabled', evaluated: 0, fired: 0, sent: [] };

    const tz = settings.timezone || 'America/Sao_Paulo';
    const today = todayInTz(tz);
    if (!settings.include_weekends && !force) {
        const d = dowOf(today);
        if (d === 0 || d === 6) return { skipped: 'weekend', today, evaluated: 0, fired: 0, sent: [] };
    }

    const [rules, statusMap] = await Promise.all([
        db.ChecklistReminderRule.findAll({ where: { active: true }, order: [['position', 'ASC']] }),
        loadStatusMap(),
    ]);
    if (!rules.length) return { today, evaluated: 0, fired: 0, sent: [] };
    const plainRules = rules.map((r) => r.get({ plain: true }));

    const tasks = await db.ChecklistTask.findAll({
        where: { due_date: { [Op.ne]: null } },
        include: [{
            association: 'checklist',
            required: true,
            attributes: ['id', 'title', 'template_id', 'owner_user_id', 'status', 'reminder_mode'],
            where: { status: 'active' },
        }],
    });

    // Dedupe: lembretes já enviados nos últimos dias (chave task:rule:date).
    const recent = await db.ChecklistActivity.findAll({
        where: { action: 'reminder.sent', created_at: { [Op.gte]: dayjs(today).subtract(3, 'day').toDate() } },
        attributes: ['task_id', 'meta'], raw: true,
    });
    const firedSet = new Set(recent.map((r) => `${r.task_id}:${r.meta?.rule_id}:${r.meta?.date}`));

    const sent = [];
    let evaluated = 0;

    for (const t of tasks) {
        const task = t.get({ plain: true });
        const checklist = task.checklist;
        const sc = task.status_id ? (statusMap.get(task.status_id)?.state_class || 'TODO') : 'TODO';
        if (sc === 'DONE' || sc === 'CANCELLED') continue;

        for (const rule of plainRules) {
            if (!ruleAppliesTo(rule, checklist)) continue;
            if (!(rule.apply_states || []).includes(sc)) continue;
            evaluated++;
            if (!shouldFireToday(rule, anchorDate(rule, task), today)) continue;

            const key = `${task.id}:${rule.id}:${today}`;
            if (firedSet.has(key)) continue;

            const recipients = resolveRecipients(rule, task, checklist);
            if (!recipients.users.length && !recipients.positions.length) continue;

            const ctx = buildCtx(task, checklist, today);
            const title = render(rule.title_template, ctx);
            const body = render(rule.body_template, ctx);

            sent.push({
                taskId: task.id, taskTitle: task.title, checklistId: checklist.id, checklistTitle: checklist.title,
                ruleId: rule.id, ruleName: rule.name, recipients, channels: rule.channels,
                title: title || `(${rule.name})`,
            });

            if (!dryRun) {
                try {
                    await dispatch({ rule, task, checklist, recipients, title, body, settings });
                    await logActivity({ checklistId: checklist.id, taskId: task.id, action: 'reminder.sent', meta: { rule_id: rule.id, date: today } });
                    firedSet.add(key);
                } catch (err) {
                    console.warn('[cobranca.dispatch] falhou:', err?.message || err);
                }
            }
        }
    }

    return { today, evaluated, fired: sent.length, sent, dryRun };
}

// ── Régua por checklist (padrão / personalizada / desligada) ──────────────────
export async function getChecklistCobranca({ checklistId }) {
    const checklist = await db.Checklist.findByPk(Number(checklistId), { attributes: ['id', 'reminder_mode'] });
    if (!checklist) throw new Error('Checklist não encontrado.');
    const rules = await db.ChecklistReminderRule.findAll({
        where: { scope: 'CHECKLIST', scope_id: checklist.id },
        order: [['position', 'ASC'], ['offset_days', 'ASC'], ['id', 'ASC']],
    });
    return { mode: checklist.reminder_mode || 'DEFAULT', rules: rules.map((r) => r.get({ plain: true })) };
}

export async function setChecklistCobranca({ checklistId, mode, rules, userId }) {
    const checklist = await db.Checklist.findByPk(Number(checklistId));
    if (!checklist) throw new Error('Checklist não encontrado.');
    if (mode && ['DEFAULT', 'CUSTOM', 'OFF'].includes(mode)) {
        checklist.reminder_mode = mode;
        await checklist.save();
    }
    if (Array.isArray(rules)) {
        // Substitui a régua própria do checklist pela lista enviada.
        await db.ChecklistReminderRule.destroy({ where: { scope: 'CHECKLIST', scope_id: checklist.id } });
        let pos = 0;
        for (const r of rules) {
            pos += 10;
            const data = { created_by: userId || null, updated_by: userId || null, scope: 'CHECKLIST', scope_id: checklist.id, position: r.position ?? pos };
            for (const f of RULE_FIELDS) if (f in r && f !== 'scope' && f !== 'scope_id') data[f] = r[f];
            await db.ChecklistReminderRule.create(data);
        }
    } else if ((mode || checklist.reminder_mode) === 'CUSTOM') {
        // Ao entrar em CUSTOM sem régua própria, clona a régua global como ponto de partida.
        const count = await db.ChecklistReminderRule.count({ where: { scope: 'CHECKLIST', scope_id: checklist.id } });
        if (count === 0) {
            const globals = await db.ChecklistReminderRule.findAll({ where: { scope: 'GLOBAL', active: true }, order: [['position', 'ASC']] });
            for (const g of globals) {
                const gp = g.get({ plain: true });
                delete gp.id; delete gp.created_at; delete gp.updated_at;
                await db.ChecklistReminderRule.create({ ...gp, scope: 'CHECKLIST', scope_id: checklist.id, created_by: userId || null, updated_by: userId || null });
            }
        }
    }
    return getChecklistCobranca({ checklistId: checklist.id });
}

export default {
    getSettings, updateSettings,
    listRules, createRule, updateRule, removeRule,
    runEngine, todayInTz, hourInTz,
    getChecklistCobranca, setChecklistCobranca,
};
