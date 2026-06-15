// routes/officeBrainRoutes.js
//
// API do "Cérebro da Eme" (Brain Studio) — admin-only. Gerencia a configuração
// DB-driven do assistente: blocos do prompt, glossário, settings e o ciclo de
// versão (rascunho → publicar → rollback).
//
// IMPORTANTE: edições mexem apenas no RASCUNHO (tabelas draft). O runtime só
// muda quando há PUBLISH (cria versão ativa) ou ROLLBACK (reativa versão antiga),
// que invalidam o cache do ConfigService. Assim editar nunca afeta a Eme ao vivo.

import express from 'express';
import authenticate from '../middlewares/authMiddleware.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import db from '../models/sequelize/index.js';
import { buildBrainFromTables, invalidateBrainCache } from '../services/OfficeAI/ConfigService.js';
import { assembleSystemPrompt } from '../services/OfficeAI/promptAssembler.js';
import { loadAccessibleEnterprises } from '../services/OfficeAI/OfficeChatService.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = express.Router();
router.use(authenticate, requireAdmin);

const BLOCK_CATEGORIES = ['identity', 'policy', 'access', 'module_rule', 'behavior', 'voice', 'custom'];
const CONTEXTS = ['OFFICE', 'ACADEMY', 'BOTH'];
const GLOSSARY_KINDS = ['voice_stt', 'vocabulary', 'forbidden'];

const actor = (req) => req.user?.username || req.user?.email || `user#${req.user?.id}`;

function slug(s, fallback = 'item') {
  const base = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90);
  return base || fallback;
}

// ── Visão geral: versão ativa + rascunho completo ────────────────────────────
router.get('/brain', async (req, res) => {
  try {
    const active = await db.EmeConfigVersion.findOne({
      where: { is_active: true },
      attributes: ['id', 'label', 'published_by', 'created_at'],
      order: [['created_at', 'DESC']],
    });
    const draft = await buildBrainFromTables();
    res.json({ active, draft });
  } catch (err) {
    console.error('[officeBrain] /brain', err);
    res.status(500).json({ error: 'Erro ao carregar o cérebro.' });
  }
});

// ─────────────────────────────── BLOCKS ─────────────────────────────────────
router.get('/blocks', async (req, res) => {
  try {
    const where = {};
    if (req.query.context) where.context = String(req.query.context).toUpperCase();
    const blocks = await db.EmePromptBlock.findAll({ where, order: [['orderIndex', 'ASC']] });
    res.json({ blocks });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar blocos.' });
  }
});

router.post('/blocks', async (req, res) => {
  try {
    const { title, category, content, context, module, orderIndex, requiredPermission } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório.' });
    if (category && !BLOCK_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Categoria inválida.' });
    if (context && !CONTEXTS.includes(String(context).toUpperCase())) return res.status(400).json({ error: 'Contexto inválido.' });

    let key = slug(req.body.key || title, 'bloco');
    // Garante unicidade do key
    if (await db.EmePromptBlock.findOne({ where: { key } })) key = `${key}_${Date.now().toString(36)}`;

    const maxOrder = await db.EmePromptBlock.max('orderIndex');
    const block = await db.EmePromptBlock.create({
      key,
      title: title.trim(),
      category: category || 'custom',
      module: module || null,
      context: (context || 'OFFICE').toUpperCase(),
      content: content || '',
      orderIndex: Number.isFinite(orderIndex) ? orderIndex : (Number(maxOrder) || 0) + 10,
      enabled: true,
      isDynamic: false,
      requiredPermission: requiredPermission || null,
      locked: false,
      updatedBy: actor(req),
    });
    res.status(201).json({ block });
  } catch (err) {
    console.error('[officeBrain] POST /blocks', err);
    res.status(500).json({ error: 'Erro ao criar bloco.' });
  }
});

router.put('/blocks/:id', async (req, res) => {
  try {
    const block = await db.EmePromptBlock.findByPk(req.params.id);
    if (!block) return res.status(404).json({ error: 'Bloco não encontrado.' });

    const patch = {};
    const { title, category, content, context, module, enabled, orderIndex, requiredPermission } = req.body || {};
    if (title !== undefined) patch.title = String(title).trim();
    if (content !== undefined) patch.content = String(content);
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (module !== undefined) patch.module = module || null;
    if (requiredPermission !== undefined) patch.requiredPermission = requiredPermission || null;
    if (orderIndex !== undefined && Number.isFinite(Number(orderIndex))) patch.orderIndex = Number(orderIndex);
    if (category !== undefined) {
      if (!BLOCK_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Categoria inválida.' });
      patch.category = category;
    }
    if (context !== undefined) {
      const c = String(context).toUpperCase();
      if (!CONTEXTS.includes(c)) return res.status(400).json({ error: 'Contexto inválido.' });
      patch.context = c;
    }
    // Bloco dinâmico: o conteúdo é injetado por código — não deixa editar o texto.
    if (block.isDynamic) delete patch.content;
    patch.updatedBy = actor(req);

    await block.update(patch);
    res.json({ block });
  } catch (err) {
    console.error('[officeBrain] PUT /blocks/:id', err);
    res.status(500).json({ error: 'Erro ao atualizar bloco.' });
  }
});

router.post('/blocks/reorder', async (req, res) => {
  try {
    const { order } = req.body || {}; // [{ id, orderIndex }]
    if (!Array.isArray(order)) return res.status(400).json({ error: 'Payload inválido.' });
    await db.sequelize.transaction(async (tx) => {
      for (const it of order) {
        if (!it?.id || !Number.isFinite(Number(it.orderIndex))) continue;
        await db.EmePromptBlock.update(
          { orderIndex: Number(it.orderIndex), updatedBy: actor(req) },
          { where: { id: it.id }, transaction: tx },
        );
      }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[officeBrain] POST /blocks/reorder', err);
    res.status(500).json({ error: 'Erro ao reordenar.' });
  }
});

router.delete('/blocks/:id', async (req, res) => {
  try {
    const block = await db.EmePromptBlock.findByPk(req.params.id);
    if (!block) return res.status(404).json({ error: 'Bloco não encontrado.' });
    if (block.locked) return res.status(409).json({ error: 'Bloco-núcleo não pode ser excluído (apenas desabilitado).' });
    if (block.isDynamic) return res.status(409).json({ error: 'Bloco dinâmico não pode ser excluído.' });
    await block.destroy();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir bloco.' });
  }
});

// ────────────────────────────── GLOSSARY ────────────────────────────────────
router.get('/glossary', async (req, res) => {
  try {
    const glossary = await db.EmeGlossaryTerm.findAll({ order: [['kind', 'ASC'], ['term', 'ASC']] });
    res.json({ glossary });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar glossário.' });
  }
});

router.post('/glossary', async (req, res) => {
  try {
    const { term, canonical, kind, context, note } = req.body || {};
    if (!term?.trim()) return res.status(400).json({ error: 'Termo obrigatório.' });
    const k = kind || 'vocabulary';
    if (!GLOSSARY_KINDS.includes(k)) return res.status(400).json({ error: 'Tipo inválido.' });

    let key = `${k === 'voice_stt' ? 'voz' : k === 'forbidden' ? 'proibida' : 'vocab'}_${slug(term, 'termo')}`;
    if (await db.EmeGlossaryTerm.findOne({ where: { key } })) key = `${key}_${Date.now().toString(36)}`;

    const row = await db.EmeGlossaryTerm.create({
      key, term: term.trim(), canonical: canonical?.trim() || null, kind: k,
      context: (context || 'OFFICE').toUpperCase(), note: note || null,
      enabled: true, updatedBy: actor(req),
    });
    res.status(201).json({ term: row });
  } catch (err) {
    console.error('[officeBrain] POST /glossary', err);
    res.status(500).json({ error: 'Erro ao criar termo.' });
  }
});

router.put('/glossary/:id', async (req, res) => {
  try {
    const row = await db.EmeGlossaryTerm.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Termo não encontrado.' });
    const patch = {};
    const { term, canonical, kind, context, note, enabled } = req.body || {};
    if (term !== undefined) patch.term = String(term).trim();
    if (canonical !== undefined) patch.canonical = canonical?.trim() || null;
    if (note !== undefined) patch.note = note || null;
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (kind !== undefined) {
      if (!GLOSSARY_KINDS.includes(kind)) return res.status(400).json({ error: 'Tipo inválido.' });
      patch.kind = kind;
    }
    if (context !== undefined) patch.context = String(context).toUpperCase();
    patch.updatedBy = actor(req);
    await row.update(patch);
    res.json({ term: row });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar termo.' });
  }
});

router.delete('/glossary/:id', async (req, res) => {
  try {
    const row = await db.EmeGlossaryTerm.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Termo não encontrado.' });
    await row.destroy();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir termo.' });
  }
});

// ────────────────────────────── SETTINGS ────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const rows = await db.EmeSetting.findAll();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar settings.' });
  }
});

router.put('/settings/:key', async (req, res) => {
  try {
    const key = String(req.params.key);
    const { value } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: 'value obrigatório.' });
    const [row] = await db.EmeSetting.findOrCreate({
      where: { key }, defaults: { key, value, updatedBy: actor(req) },
    });
    await row.update({ value, updatedBy: actor(req) });
    res.json({ setting: row });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar setting.' });
  }
});

// ─────────────────────────────── REPORTS ────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const reports = await db.EmeReport.findAll({ order: [['name', 'ASC']] });
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar relatórios.' });
  }
});

router.put('/reports/:id', async (req, res) => {
  try {
    const r = await db.EmeReport.findByPk(req.params.id);
    if (!r) return res.status(404).json({ error: 'Relatório não encontrado.' });
    const patch = {};
    const { enabled, description, promptRules, requiredPermission, adminOnly } = req.body || {};
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (description !== undefined) patch.description = description || null;
    if (promptRules !== undefined) patch.promptRules = promptRules || null;
    if (requiredPermission !== undefined) patch.requiredPermission = requiredPermission || null;
    if (adminOnly !== undefined) patch.adminOnly = !!adminOnly;
    patch.updatedBy = actor(req);
    await r.update(patch);
    res.json({ report: r });
  } catch (err) {
    console.error('[officeBrain] PUT /reports/:id', err);
    res.status(500).json({ error: 'Erro ao atualizar relatório.' });
  }
});

// ───────────────────────── VERSÕES / PUBLISH / ROLLBACK ──────────────────────
router.get('/versions', async (req, res) => {
  try {
    const versions = await db.EmeConfigVersion.findAll({
      attributes: ['id', 'label', 'status', 'is_active', 'published_by', 'note', 'created_at'],
      order: [['created_at', 'DESC']],
      limit: 50,
    });
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar versões.' });
  }
});

// Congela o rascunho atual como nova versão ativa. A partir daqui o runtime lê do banco.
router.post('/publish', async (req, res) => {
  try {
    const { label, note } = req.body || {};
    const payload = await buildBrainFromTables();
    const version = await db.sequelize.transaction(async (tx) => {
      await db.EmeConfigVersion.update({ is_active: false }, { where: { is_active: true }, transaction: tx });
      return db.EmeConfigVersion.create({
        label: label?.trim() || `Publicação ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        payload, status: 'published', is_active: true,
        published_by: actor(req), note: note || null,
      }, { transaction: tx });
    });
    invalidateBrainCache();
    res.status(201).json({ version: { id: version.id, label: version.label, is_active: true } });
  } catch (err) {
    console.error('[officeBrain] POST /publish', err);
    res.status(500).json({ error: 'Erro ao publicar.' });
  }
});

// Reativa uma versão anterior (runtime volta a ela na hora). O rascunho não é tocado.
router.post('/rollback/:id', async (req, res) => {
  try {
    const target = await db.EmeConfigVersion.findByPk(req.params.id);
    if (!target) return res.status(404).json({ error: 'Versão não encontrada.' });
    await db.sequelize.transaction(async (tx) => {
      await db.EmeConfigVersion.update({ is_active: false }, { where: { is_active: true }, transaction: tx });
      await target.update({ is_active: true }, { transaction: tx });
    });
    invalidateBrainCache();
    res.json({ ok: true, active: target.id });
  } catch (err) {
    console.error('[officeBrain] POST /rollback', err);
    res.status(500).json({ error: 'Erro ao reverter.' });
  }
});

// Desativa o cérebro DB-driven: runtime volta ao fallback hardcoded.
router.post('/deactivate', async (req, res) => {
  try {
    await db.EmeConfigVersion.update({ is_active: false }, { where: { is_active: true } });
    invalidateBrainCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desativar.' });
  }
});

// ──────────────────────────────── SANDBOX ───────────────────────────────────
// Testa o RASCUNHO antes de publicar: monta o prompt com um usuário SIMULADO e
// (opcionalmente) roda uma resposta one-shot do Gemini. Nada é persistido e o
// cérebro ativo não é afetado.

function simulatedUser({ role, city }) {
  return {
    username: '(sandbox)',
    role: role === 'admin' ? 'admin' : 'user',
    city: city?.trim() || null,
    position: '(teste)',
    email: 'sandbox@local',
  };
}

// Preview do prompt montado (sem Gemini) — mostra EXATAMENTE o que o cérebro gera.
router.post('/sandbox/preview', async (req, res) => {
  try {
    const { role, city } = req.body || {};
    const user = simulatedUser({ role, city });
    const enterprises = await loadAccessibleEnterprises(user).catch(() => []);
    const brain = await buildBrainFromTables();
    const systemPrompt = assembleSystemPrompt(brain, user, enterprises, 'OFFICE');
    res.json({
      systemPrompt,
      char_count: systemPrompt.length,
      blocks_used: (brain.blocks || []).filter(b => b.enabled !== false).length,
      simulated: { role: user.role, city: user.city, enterprises: enterprises.length },
    });
  } catch (err) {
    console.error('[officeBrain] sandbox/preview', err);
    res.status(500).json({ error: 'Erro ao montar preview.' });
  }
});

function sandboxKeys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
function sandboxModel() {
  return (process.env.GEMINI_FAST_MODELS || process.env.GEMINI_MODELS || 'gemini-2.5-flash')
    .split(',')[0].trim();
}

// Resposta one-shot do Gemini com o prompt do rascunho (SEM tools, SEM persistir).
// Valida persona/tom/regras. Comportamento de dados (tools) é testado no chat real.
router.post('/sandbox/chat', async (req, res) => {
  try {
    const { message, role, city } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'Mensagem obrigatória.' });
    const keys = sandboxKeys();
    if (!keys.length) return res.status(503).json({ error: 'GEMINI_API_KEY não configurada.' });

    const user = simulatedUser({ role, city });
    const enterprises = await loadAccessibleEnterprises(user).catch(() => []);
    const brain = await buildBrainFromTables();
    const systemPrompt = assembleSystemPrompt(brain, user, enterprises, 'OFFICE');

    const model = sandboxModel();
    const genAI = new GoogleGenerativeAI(keys[0]);
    const mdl = genAI.getGenerativeModel({ model, systemInstruction: systemPrompt });
    const result = await mdl.generateContent(message.trim());
    const text = result?.response?.text?.() || '';

    res.json({ text, model, prompt_chars: systemPrompt.length, note: 'Sandbox sem ferramentas — valida persona/tom/regras.' });
  } catch (err) {
    console.error('[officeBrain] sandbox/chat', err?.message || err);
    res.status(502).json({ error: 'Falha ao gerar resposta de teste.' });
  }
});

export default router;
