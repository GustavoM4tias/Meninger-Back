// routes/whatsappAutomationRoutes.js
//
// CRUD das automações de WhatsApp (no-code studio) — admin only. Edições
// invalidam o cache do WhatsAppAutomationService, então o runtime pega na hora.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import db from '../models/sequelize/index.js';
import { invalidateAutomationCache } from '../services/whatsapp/WhatsAppAutomationService.js';
import WhatsAppService from '../services/whatsapp/WhatsAppService.js';

const router = express.Router();
router.use(authenticate, requireAdmin);

const TRIGGER_TYPES = ['schedule', 'event', 'manual'];
const actor = (req) => req.user?.username || req.user?.email || `user#${req.user?.id}`;

// Catálogo de eventos que podem virar gatilho (mostrado no builder).
const AVAILABLE_EVENTS = [
  { value: 'alert.fired',      label: 'Alerta da Eme disparado' },
  { value: 'boleto.generated', label: 'Boleto gerado' },
  { value: 'event.reminder',   label: 'Lembrete de evento (D-1)' },
  { value: 'lead.created',     label: 'Lead novo' },
];

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90) || 'automacao';
}

const EDITABLE = ['name', 'description', 'templateName', 'templateLanguage', 'triggerConfig',
  'variableMapping', 'buttons', 'replyActions', 'recipients', 'category'];

router.get('/', async (req, res) => {
  try {
    const automations = await db.WhatsappAutomation.findAll({ order: [['is_system', 'DESC'], ['name', 'ASC']] });
    res.json({ automations, events: AVAILABLE_EVENTS, triggerTypes: TRIGGER_TYPES });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar automações.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name?.trim()) return res.status(400).json({ error: 'Nome obrigatório.' });
    if (b.triggerType && !TRIGGER_TYPES.includes(b.triggerType)) return res.status(400).json({ error: 'Gatilho inválido.' });

    let key = slug(b.key || b.name);
    if (await db.WhatsappAutomation.findOne({ where: { key } })) key = `${key}_${Date.now().toString(36)}`;

    const auto = await db.WhatsappAutomation.create({
      key,
      name: b.name.trim(),
      description: b.description || null,
      enabled: true,
      triggerType: b.triggerType || 'manual',
      triggerConfig: b.triggerConfig || null,
      templateName: b.templateName || null,
      templateLanguage: b.templateLanguage || 'pt_BR',
      variableMapping: b.variableMapping || null,
      buttons: b.buttons || null,
      replyActions: b.replyActions || null,
      recipients: b.recipients || null,
      category: b.category || 'UTILITY',
      isSystem: false,
      createdBy: actor(req),
      updatedBy: actor(req),
    });
    invalidateAutomationCache();
    res.status(201).json({ automation: auto });
  } catch (err) {
    console.error('[whatsappAutomations] POST', err);
    res.status(500).json({ error: 'Erro ao criar automação.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const auto = await db.WhatsappAutomation.findByPk(req.params.id);
    if (!auto) return res.status(404).json({ error: 'Automação não encontrada.' });

    const b = req.body || {};
    const patch = {};
    for (const f of EDITABLE) if (b[f] !== undefined) patch[f] = b[f];
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.triggerType !== undefined) {
      if (!TRIGGER_TYPES.includes(b.triggerType)) return res.status(400).json({ error: 'Gatilho inválido.' });
      patch.triggerType = b.triggerType;
    }
    patch.updatedBy = actor(req);

    await auto.update(patch);
    invalidateAutomationCache();
    res.json({ automation: auto });
  } catch (err) {
    console.error('[whatsappAutomations] PUT', err);
    res.status(500).json({ error: 'Erro ao atualizar automação.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const auto = await db.WhatsappAutomation.findByPk(req.params.id);
    if (!auto) return res.status(404).json({ error: 'Automação não encontrada.' });
    if (auto.isSystem) return res.status(409).json({ error: 'Automação de sistema não pode ser excluída (apenas desabilitada).' });
    await auto.destroy();
    invalidateAutomationCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir automação.' });
  }
});

// ── Conexão webhook ↔ WABA (subscribed_apps) ────────────────────────────────
// Resolve o caso "a Meta verifica a URL mas não repassa as mensagens": conecta
// a WABA ao app usando o waba_id + token já salvos. Um clique, sem Graph Explorer.
router.get('/webhook-status', async (req, res) => {
  try {
    const data = await WhatsAppService.getSubscribedApps();
    const apps = Array.isArray(data?.data) ? data.data : [];
    res.json({ subscribed: apps.length > 0, apps });
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Falha ao verificar a conexão.' });
  }
});

router.post('/connect-webhook', async (req, res) => {
  try {
    const result = await WhatsAppService.subscribeWaba();
    const check = await WhatsAppService.getSubscribedApps().catch(() => null);
    const apps = Array.isArray(check?.data) ? check.data : [];
    res.json({ ok: true, result, subscribed: apps.length > 0, apps });
  } catch (err) {
    console.error('[whatsappAutomations] connect-webhook', err?.message);
    res.status(400).json({ error: err?.message || 'Falha ao conectar a WABA ao webhook.' });
  }
});

// ── Templates (catálogo + criar/submeter à Meta) ────────────────────────────
router.get('/templates', async (req, res) => {
  try {
    const templates = await db.WhatsappTemplate.findAll({ order: [['name', 'ASC']] });
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar templates.' });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name?.trim() || !b.body?.trim() || !b.category) {
      return res.status(400).json({ error: 'name, category e body são obrigatórios.' });
    }
    const result = await WhatsAppService.createTemplate({
      name: b.name.trim(),
      category: b.category,
      language: b.language || 'pt_BR',
      body: b.body,
      headerText: b.headerText || undefined,
      footerText: b.footerText || undefined,
      buttons: Array.isArray(b.buttons) ? b.buttons : [],
      examples: Array.isArray(b.examples) ? b.examples : [],
    });
    res.status(201).json({ ok: true, result });
  } catch (err) {
    // CloudApiError / validações locais trazem mensagem clara — devolve 400.
    const msg = err?.message || 'Falha ao criar template.';
    console.error('[whatsappAutomations] POST /templates', msg);
    res.status(400).json({ error: msg });
  }
});

export default router;
