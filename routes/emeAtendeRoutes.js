// routes/emeAtendeRoutes.js
//
// Administração da Eme Atende (atendente IA de leads) - admin only, auth do Office.
// A futura tela no front consome exatamente estas rotas. Templates são os do
// canal WhatsApp do Office (whatsapp_templates - sync/criação na tela e rotas
// já existentes de /api/whatsapp e /api/whatsapp-automations).

import express from 'express';
import crypto from 'crypto';
import { Op } from 'sequelize';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import db from '../models/sequelize/index.js';
import EmeAtendeSettingsService from '../services/emeAtende/EmeAtendeSettingsService.js';
import EmeAtendeFlowService from '../services/emeAtende/EmeAtendeFlowService.js';
import EmeAtendeConversationEngine from '../services/emeAtende/EmeAtendeConversationEngine.js';
import { runChat } from '../services/emeAtende/emeAtendeGeminiChat.js';

const router = express.Router();
router.use(authenticate, requireAdmin);

const wrap = fn => (req, res) => fn(req, res).catch(err => {
    console.error('[eme-atende/admin]', err?.message || err);
    res.status(500).json({ error: err?.message || 'Erro interno.' });
});

// ── Settings ─────────────────────────────────────────────────────────────────
router.get('/settings', wrap(async (req, res) => {
    res.json(await EmeAtendeSettingsService.getConfig());
}));

router.put('/settings', wrap(async (req, res) => {
    res.json(await EmeAtendeSettingsService.updateConfig(req.body || {}));
}));

// ── API keys (a key em claro só aparece UMA vez, na criação) ─────────────────
router.get('/api-keys', wrap(async (req, res) => {
    res.json(await db.EmeAtendeApiKey.findAll({
        attributes: ['id', 'name', 'active', 'last_used_at', 'created_at'],
        order: [['id', 'ASC']],
    }));
}));

router.post('/api-keys', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name é obrigatório.' });
    const key = `eme_atende_${crypto.randomBytes(24).toString('hex')}`;
    const key_hash = crypto.createHash('sha256').update(key).digest('hex');
    const row = await db.EmeAtendeApiKey.create({ name, key_hash });
    res.status(201).json({ id: row.id, name, key, aviso: 'Guarde a key - ela não será exibida de novo.' });
}));

router.delete('/api-keys/:id', wrap(async (req, res) => {
    const row = await db.EmeAtendeApiKey.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'não encontrada' });
    await row.update({ active: false });
    res.json({ ok: true });
}));

// ── Flows ────────────────────────────────────────────────────────────────────
const FLOW_FIELDS = ['name', 'active', 'is_default', 'system_prompt', 'business_context',
    'opener_template', 'opener_language', 'opener_variables', 'triggers', 'handoff', 'settings'];

router.get('/flows', wrap(async (req, res) => {
    res.json(await db.EmeAtendeFlow.findAll({
        include: [{ model: db.EmeAtendeFlowRule, as: 'rules' }],
        order: [['id', 'ASC']],
    }));
}));

router.post('/flows', wrap(async (req, res) => {
    const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => FLOW_FIELDS.includes(k)));
    if (!data.name) return res.status(400).json({ error: 'name é obrigatório.' });
    if (data.is_default) await db.EmeAtendeFlow.update({ is_default: false }, { where: {} });
    const row = await db.EmeAtendeFlow.create(data);
    EmeAtendeFlowService.invalidate();
    res.status(201).json(row);
}));

router.put('/flows/:id', wrap(async (req, res) => {
    const row = await db.EmeAtendeFlow.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'não encontrado' });
    const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => FLOW_FIELDS.includes(k)));
    if (data.is_default) await db.EmeAtendeFlow.update({ is_default: false }, { where: { id: { [Op.ne]: row.id } } });
    await row.update(data);
    EmeAtendeFlowService.invalidate();
    res.json(row);
}));

router.delete('/flows/:id', wrap(async (req, res) => {
    const row = await db.EmeAtendeFlow.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'não encontrado' });
    await row.update({ active: false });
    EmeAtendeFlowService.invalidate();
    res.json({ ok: true, aviso: 'Fluxo desativado (não apagado - conversas antigas referenciam).' });
}));

// ── Flow rules (segmentação) ─────────────────────────────────────────────────
router.get('/flow-rules', wrap(async (req, res) => {
    res.json(await db.EmeAtendeFlowRule.findAll({
        include: [{ model: db.EmeAtendeFlow, as: 'flow', attributes: ['id', 'name'] }],
        order: [['priority', 'ASC'], ['id', 'ASC']],
    }));
}));

router.post('/flow-rules', wrap(async (req, res) => {
    const { field, operator = 'contains', value, flow_id, priority = 100, active = true } = req.body || {};
    if (!field || !value || !flow_id) return res.status(400).json({ error: 'field, value e flow_id são obrigatórios.' });
    const row = await db.EmeAtendeFlowRule.create({ field, operator, value, flow_id, priority, active });
    EmeAtendeFlowService.invalidate();
    res.status(201).json(row);
}));

router.put('/flow-rules/:id', wrap(async (req, res) => {
    const row = await db.EmeAtendeFlowRule.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'não encontrada' });
    const data = Object.fromEntries(Object.entries(req.body || {})
        .filter(([k]) => ['field', 'operator', 'value', 'flow_id', 'priority', 'active'].includes(k)));
    await row.update(data);
    EmeAtendeFlowService.invalidate();
    res.json(row);
}));

router.delete('/flow-rules/:id', wrap(async (req, res) => {
    const n = await db.EmeAtendeFlowRule.destroy({ where: { id: req.params.id } });
    EmeAtendeFlowService.invalidate();
    res.json({ ok: n > 0 });
}));

// ── Templates do canal (leitura; gestão fica em /api/whatsapp[-automations]) ─
router.get('/templates', wrap(async (req, res) => {
    const where = {};
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    res.json(await db.WhatsappTemplate.findAll({ where, order: [['name', 'ASC']] }));
}));

// ── Leads ────────────────────────────────────────────────────────────────────
router.get('/leads', wrap(async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.q) {
        where[Op.or] = [
            { name: { [Op.iLike]: `%${req.query.q}%` } },
            { phone: { [Op.like]: `%${req.query.q}%` } },
        ];
    }
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const offset = Number(req.query.offset || 0);
    const { rows, count } = await db.EmeAtendeLead.findAndCountAll({
        where,
        include: [{ model: db.EmeAtendeFlow, as: 'flow', attributes: ['id', 'name'] }],
        order: [['id', 'DESC']],
        limit, offset,
    });
    res.json({ total: count, leads: rows });
}));

router.get('/leads/:id', wrap(async (req, res) => {
    const row = await db.EmeAtendeLead.findByPk(req.params.id, {
        include: [
            { model: db.EmeAtendeFlow, as: 'flow', attributes: ['id', 'name'] },
            { model: db.EmeAtendeEvent, as: 'events' },
        ],
        order: [[{ model: db.EmeAtendeEvent, as: 'events' }, 'id', 'ASC']],
    });
    if (!row) return res.status(404).json({ error: 'não encontrado' });
    res.json(row);
}));

// ── Conversas ────────────────────────────────────────────────────────────────
router.get('/conversations', wrap(async (req, res) => {
    const where = {};
    if (req.query.state) where.state = req.query.state;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    res.json(await db.EmeAtendeConversation.findAll({
        where,
        include: [{ model: db.EmeAtendeLead, as: 'lead', attributes: ['id', 'name', 'phone', 'status', 'source'] }],
        order: [['updated_at', 'DESC']],
        limit,
    }));
}));

router.get('/conversations/:id', wrap(async (req, res) => {
    const row = await db.EmeAtendeConversation.findByPk(req.params.id, {
        include: [
            { model: db.EmeAtendeLead, as: 'lead' },
            { model: db.EmeAtendeMessage, as: 'messages' },
        ],
        order: [[{ model: db.EmeAtendeMessage, as: 'messages' }, 'id', 'ASC']],
    });
    if (!row) return res.status(404).json({ error: 'não encontrada' });
    res.json(row);
}));

/** Muda o estado (bot|human|closed) - humano assume ou devolve pro bot. */
router.put('/conversations/:id/state', wrap(async (req, res) => {
    const state = String(req.body?.state || '');
    if (!['bot', 'human', 'closed'].includes(state)) {
        return res.status(400).json({ error: 'state deve ser bot|human|closed.' });
    }
    const row = await db.EmeAtendeConversation.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'não encontrada' });
    await row.update({ state });
    await db.EmeAtendeEvent.create({
        lead_id: row.lead_id, conversation_id: row.id,
        type: 'state_changed_by_admin',
        detail: { state, by: req.user?.username || req.user?.email || `user#${req.user?.id}` },
    });
    res.json(row);
}));

// ── Sandbox: testa o prompt de um fluxo SEM enviar nada ──────────────────────
router.post('/test/ai', wrap(async (req, res) => {
    const { flow_id, message, history = [] } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message é obrigatório.' });
    const flow = flow_id ? await db.EmeAtendeFlow.findByPk(flow_id) : await EmeAtendeFlowService.getDefaultFlow();
    if (!flow) return res.status(404).json({ error: 'fluxo não encontrado.' });

    const fakeLead = { name: req.body?.lead_name || 'Lead de Teste', empreendimento: req.body?.empreendimento || null };
    const persona = flow.system_prompt || '';
    const context = flow.business_context ? `\n\nCONTEXTO DO NEGÓCIO:\n${flow.business_context}` : '';
    const systemPrompt = `${persona}${context}\n\nDADOS DO LEAD: nome=${fakeLead.name}; empreendimento=${fakeLead.empreendimento || '-'}.\n(Modo sandbox de teste.)`;

    const result = await runChat({
        systemPrompt,
        history: history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        userMessage: String(message),
        functionDeclarations: EmeAtendeConversationEngine.FUNCTION_DECLARATIONS,
        onTool: async () => ({ ok: true, info: 'sandbox - ação simulada' }),
    });
    res.json({ reply: result.text, tool_calls: result.toolCalls });
}));

export default router;
