// controllers/alertController.js
//
// Endpoints REST de gestão das regras de alerta.
//
// Permissões:
//   - User comum: vê/edita/deleta SOMENTE as próprias regras (owner_user_id = req.user.id)
//                 cria SOMENTE pra si mesmo (owner_user_id forçado)
//   - Admin:      vê/edita/deleta tudo; pode criar pra outros users
//
// IMPORTANTE: a UI não usa POST /api/alerts diretamente — quem cria é a Eme
// via tool function call (que internamente chama esse endpoint). UI só faz
// listar, editar (cron/canais), toggle, deletar.

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import AlertEngine from '../services/alerts/AlertEngine.js';
import AlertReportService from '../services/alerts/AlertReportService.js';

const { AlertRule, AlertTriggerLog, User } = db;

const isAdmin = (req) => req.user?.role === 'admin';

// ─── Validação ───────────────────────────────────────────────────────────────

/**
 * Mínimo de 20min entre disparos. Cron com intervalo menor é rejeitado.
 * Heurística simples: roda o parser por 25 minutos e conta disparos previstos.
 * Se prever > 1 disparo nesse intervalo, rejeita.
 */
function validateCronMinInterval(cronExpr) {
    if (!cron.validate(cronExpr)) return { valid: false, reason: 'Expressão cron inválida.' };

    // Detecta padrões claramente abaixo de 20min: */N onde N < 20 nos minutos
    const minutesField = String(cronExpr).trim().split(/\s+/)[0] || '';
    const stepMatch = minutesField.match(/^\*\/(\d+)$/);
    if (stepMatch && Number(stepMatch[1]) < 20) {
        return { valid: false, reason: 'Intervalo mínimo é de 20 minutos entre disparos.' };
    }
    // listagem explícita curta (ex: "0,10,20,30,40,50" = a cada 10min)
    if (minutesField.includes(',')) {
        const list = minutesField.split(',').map(n => Number(n)).filter(n => !Number.isNaN(n)).sort((a,b)=>a-b);
        for (let i = 1; i < list.length; i++) {
            if (list[i] - list[i-1] < 20) {
                return { valid: false, reason: 'Intervalo mínimo é de 20 minutos entre disparos.' };
            }
        }
    }
    return { valid: true };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PUBLIC_FIELDS = [
    'id', 'name', 'description', 'enabled',
    'owner_user_id', 'created_by_user_id', 'created_via_chat_session_id',
    'trigger_type', 'cron', 'timezone',
    'tool_call', 'title_template', 'preview_template',
    'channels', 'cooldown_minutes',
    'last_triggered_at', 'trigger_count', 'created_at', 'updated_at',
];

async function loadRuleForUser(req, id) {
    const rule = await AlertRule.findByPk(Number(id), {
        include: [{ model: User, as: 'owner', attributes: ['id', 'username', 'email'] }],
    });
    if (!rule) return { error: 'not_found' };
    if (!isAdmin(req) && rule.owner_user_id !== req.user.id) return { error: 'forbidden' };
    return { rule };
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/** GET /api/alerts — lista as regras visíveis pro user */
export const list = async (req, res) => {
    try {
        const where = {};
        if (!isAdmin(req)) where.owner_user_id = req.user.id;
        if (req.query.owner_user_id && isAdmin(req)) where.owner_user_id = Number(req.query.owner_user_id);

        const rules = await AlertRule.findAll({
            where,
            include: [{ model: User, as: 'owner', attributes: ['id', 'username', 'email'] }],
            order: [['enabled', 'DESC'], ['updated_at', 'DESC']],
            limit: 200,
        });
        return res.json({ items: rules.map(r => r.get({ plain: true })) });
    } catch (err) {
        console.error('[alerts/list]', err);
        return res.status(500).json({ error: 'Falha ao listar alertas.' });
    }
};

/** GET /api/alerts/:id */
export const getOne = async (req, res) => {
    const { rule, error } = await loadRuleForUser(req, req.params.id);
    if (error === 'not_found') return res.status(404).json({ error: 'Alerta não encontrado.' });
    if (error === 'forbidden') return res.status(403).json({ error: 'Sem permissão.' });
    return res.json({ rule: rule.get({ plain: true }) });
};

/**
 * POST /api/alerts — chamado pela Eme (tool create_alert).
 * Body: { name, description?, owner_user_id?, trigger_type?, cron, timezone?,
 *         tool_call, title_template, preview_template, channels?, cooldown_minutes? }
 */
export const create = async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.name)            return res.status(400).json({ error: 'name é obrigatório.' });
        if (!body.cron)            return res.status(400).json({ error: 'cron é obrigatório (por enquanto só schedule).' });
        if (!body.tool_call?.tool) return res.status(400).json({ error: 'tool_call.tool é obrigatório.' });
        if (!body.title_template)  return res.status(400).json({ error: 'title_template é obrigatório.' });

        const v = validateCronMinInterval(body.cron);
        if (!v.valid) return res.status(400).json({ error: v.reason });

        // Owner: user comum só pra si; admin pode setar outro
        let ownerId = req.user.id;
        if (isAdmin(req) && body.owner_user_id) {
            const target = await User.findByPk(Number(body.owner_user_id), { attributes: ['id'] });
            if (!target) return res.status(400).json({ error: 'owner_user_id inexistente.' });
            ownerId = target.id;
        }

        const rule = await AlertRule.create({
            name:        String(body.name).slice(0, 180),
            description: body.description || null,
            owner_user_id:      ownerId,
            created_by_user_id: req.user.id,
            created_via_chat_session_id: body.created_via_chat_session_id || null,

            trigger_type: 'schedule',
            cron:         body.cron,
            timezone:     body.timezone || 'America/Sao_Paulo',

            tool_call:        body.tool_call,
            title_template:   body.title_template,
            preview_template: body.preview_template || null,

            channels: {
                inapp:    body.channels?.inapp    !== false,
                email:    !!body.channels?.email,
                whatsapp: !!body.channels?.whatsapp,
            },
            cooldown_minutes: Math.max(0, Number(body.cooldown_minutes) || 0),
            enabled: body.enabled !== false,
        });

        AlertEngine.schedule(rule);

        return res.status(201).json({ rule: rule.get({ plain: true }) });
    } catch (err) {
        console.error('[alerts/create]', err);
        return res.status(500).json({ error: err.message });
    }
};

/**
 * PUT /api/alerts/:id — só campos de gestão (cron, timezone, channels, enabled, name, description).
 * tool_call NÃO é editável aqui (mudaria a "receita" — só recriar via Eme).
 */
export const update = async (req, res) => {
    try {
        const { rule, error } = await loadRuleForUser(req, req.params.id);
        if (error === 'not_found') return res.status(404).json({ error: 'Alerta não encontrado.' });
        if (error === 'forbidden') return res.status(403).json({ error: 'Sem permissão.' });

        const body = req.body || {};
        const patch = {};

        if (typeof body.name === 'string')            patch.name = body.name.slice(0, 180);
        if (typeof body.description === 'string')     patch.description = body.description;
        if (typeof body.timezone === 'string')        patch.timezone = body.timezone;
        if (typeof body.cooldown_minutes === 'number') patch.cooldown_minutes = Math.max(0, body.cooldown_minutes);
        if (typeof body.enabled === 'boolean')        patch.enabled = body.enabled;

        if (typeof body.cron === 'string') {
            const v = validateCronMinInterval(body.cron);
            if (!v.valid) return res.status(400).json({ error: v.reason });
            patch.cron = body.cron;
        }

        if (body.channels && typeof body.channels === 'object') {
            patch.channels = {
                inapp:    body.channels.inapp    !== false,
                email:    !!body.channels.email,
                whatsapp: !!body.channels.whatsapp,
            };
        }

        await rule.update(patch);
        AlertEngine.reschedule(rule.id);

        return res.json({ rule: rule.get({ plain: true }) });
    } catch (err) {
        console.error('[alerts/update]', err);
        return res.status(500).json({ error: err.message });
    }
};

/** DELETE /api/alerts/:id */
export const remove = async (req, res) => {
    try {
        const { rule, error } = await loadRuleForUser(req, req.params.id);
        if (error === 'not_found') return res.status(404).json({ error: 'Alerta não encontrado.' });
        if (error === 'forbidden') return res.status(403).json({ error: 'Sem permissão.' });

        AlertEngine.unschedule(rule.id);
        await rule.destroy();
        return res.json({ ok: true });
    } catch (err) {
        console.error('[alerts/remove]', err);
        return res.status(500).json({ error: err.message });
    }
};

/** POST /api/alerts/:id/fire — força disparo manual (debug/teste). */
export const fireNow = async (req, res) => {
    try {
        const { rule, error } = await loadRuleForUser(req, req.params.id);
        if (error === 'not_found') return res.status(404).json({ error: 'Alerta não encontrado.' });
        if (error === 'forbidden') return res.status(403).json({ error: 'Sem permissão.' });

        AlertEngine.fire(rule.id, { force: true })
            .catch(err => console.error('[alerts/fireNow]', err));
        return res.json({ ok: true, message: 'Disparo solicitado.' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/** GET /api/alerts/:id/logs */
export const logs = async (req, res) => {
    try {
        const { rule, error } = await loadRuleForUser(req, req.params.id);
        if (error === 'not_found') return res.status(404).json({ error: 'Alerta não encontrado.' });
        if (error === 'forbidden') return res.status(403).json({ error: 'Sem permissão.' });

        const items = await AlertTriggerLog.findAll({
            where: { alert_rule_id: rule.id },
            order: [['fired_at', 'DESC']],
            limit: 50,
        });
        return res.json({ items: items.map(i => i.get({ plain: true })) });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/**
 * POST /api/alerts/preview
 * body: { tool_call, timezone? }
 * Roda o tool_call uma vez sem persistir nada — usado pela Eme antes de criar a regra
 * pra mostrar ao user um exemplo do que ele vai receber.
 */
export const preview = async (req, res) => {
    try {
        const { tool_call, timezone } = req.body || {};
        if (!tool_call?.tool) return res.status(400).json({ error: 'tool_call.tool é obrigatório.' });

        const result = await AlertReportService.preview(tool_call, req.user, timezone);
        return res.json({
            preview: result.preview,
            report:  result.report,
            // raw fica de fora pra resposta não inflar — caller só precisa do que vai virar texto
        });
    } catch (err) {
        console.error('[alerts/preview]', err);
        return res.status(500).json({ error: err.message });
    }
};
