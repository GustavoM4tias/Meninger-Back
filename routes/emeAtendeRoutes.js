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
import EmeAtendeContextBuilder from '../services/emeAtende/EmeAtendeContextBuilder.js';
import { runChat } from '../services/emeAtende/emeAtendeGeminiChat.js';
import { findUnsupported } from '../services/emeAtende/emeAtendeGuard.js';
import { buildInstructions, mergeStandards, HARD_RULES } from '../services/emeAtende/emeAtendeRules.js';
import EmeAtendeSiteSyncService from '../services/emeAtende/EmeAtendeSiteSyncService.js';
import { fetchEnterprises } from '../services/emeAtende/emeAtendeSiteSource.js';

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
    // attendance_rules/standards = regras de ATENDIMENTO deste empreendimento.
    // Não confundir com a associação `rules` (segmentação de leads).
    'attendance_rules', 'standards',
    'cv_enterprise_id', 'context_sources', 'images',
    // site_slug é o único campo do site que a tela grava: snapshot,
    // site_synced_at e site_sync_error são escritos pelo sync, nunca pelo cliente.
    'site_slug',
    'opener_template', 'opener_language', 'opener_variables', 'triggers', 'settings'];

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
    // Vinculou ao site? puxa o conteúdo agora - esperar o scheduler da
    // madrugada deixaria o fluxo sem contexto no dia da configuração.
    if (row.site_slug) await EmeAtendeSiteSyncService.syncFlows({ flowId: row.id }).catch(() => null);
    res.status(201).json(await row.reload());
}));

router.put('/flows/:id', wrap(async (req, res) => {
    const row = await db.EmeAtendeFlow.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'não encontrado' });
    const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => FLOW_FIELDS.includes(k)));
    if (data.is_default) await db.EmeAtendeFlow.update({ is_default: false }, { where: { id: { [Op.ne]: row.id } } });
    const slugMudou = data.site_slug !== undefined && data.site_slug !== row.site_slug;
    await row.update(data);
    EmeAtendeFlowService.invalidate();
    // Só re-sincroniza quando o vínculo mudou: salvar o fluxo por outro
    // motivo não precisa bater no site.
    if (slugMudou && row.site_slug) await EmeAtendeSiteSyncService.syncFlows({ flowId: row.id }).catch(() => null);
    res.json(await row.reload());
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

// ── Empreendimentos do CV (pro vínculo do fluxo por centro de custo) ─────────
router.get('/enterprises', wrap(async (req, res) => {
    res.json(await db.CvEnterprise.findAll({
        attributes: ['idempreendimento', 'nome', 'cidade', 'estado', 'situacao_comercial_nome'],
        order: [['nome', 'ASC']],
    }));
}));

// ── Empreendimentos do SITE institucional ───────────────────────────────────
// Lista ao vivo (uma requisição traz o site inteiro) pro Select do editor de
// fluxo. Erro aqui é 502 com a mensagem real: "não consegui ler o site" é
// informação útil pro admin, silêncio não é.
router.get('/site/enterprises', wrap(async (req, res) => {
    const cfg = await EmeAtendeSettingsService.getConfig();
    try {
        const all = await fetchEnterprises(cfg.site_url);
        res.json(all.map(e => ({
            slug: e.slug, nome: e.nome, cidade: e.cidade, status: e.status, perfil: e.perfil,
            imagens: e.images.length, book: !!e.book,
        })));
    } catch (err) {
        res.status(502).json({ error: `falha lendo o site: ${err.message}` });
    }
}));

// Força o sync agora (o automático é 1x/dia). flow_id opcional = só um fluxo.
router.post('/site/sync', wrap(async (req, res) => {
    const flowId = req.body?.flow_id ? Number(req.body.flow_id) : null;
    const out = await EmeAtendeSiteSyncService.syncFlows({ flowId });
    EmeAtendeFlowService.invalidate();
    res.status(out.error ? 502 : 200).json(out);
}));

// ── Preview das REGRAS montadas em camadas ──────────────────────────────────
// Mostra exatamente o bloco de instruções que vai pro modelo: persona → gerais
// → padrões → específicas do empreendimento → inegociáveis. Aceita o estado
// AINDA NÃO SALVO do editor, pra dar pra calibrar antes de gravar.
router.post('/rules-preview', wrap(async (req, res) => {
    const { flow_id, attendance_rules, standards, system_prompt, name } = req.body || {};
    const saved = flow_id ? await db.EmeAtendeFlow.findByPk(flow_id) : null;
    const cfg = await EmeAtendeSettingsService.getConfig();

    const probe = {
        name: name !== undefined ? name : (saved?.name || null),
        system_prompt: system_prompt !== undefined ? system_prompt : (saved?.system_prompt || null),
        attendance_rules: attendance_rules !== undefined ? attendance_rules : (saved?.attendance_rules || null),
        standards: standards !== undefined ? standards : (saved?.standards || {}),
    };

    const effective = mergeStandards(cfg.standards, probe.standards);
    const instructions = buildInstructions({
        globalPersona: cfg.global_persona,
        globalRules: cfg.global_rules,
        flow: probe,
        standards: effective,
    });

    res.json({
        instructions,                       // o que a IA lê, já montado
        hard_rules: HARD_RULES,             // piso fixo, sempre por último
        effective_standards: effective,     // geral + override do empreendimento
        inherits_persona: !probe.system_prompt,
    });
}));

// ── Preview do contexto automático (CV + ficha comercial, ao vivo) ───────────
// Aceita valores AINDA NÃO SALVOS (a tela manda o estado do editor).
router.post('/context-preview', wrap(async (req, res) => {
    const { flow_id, cv_enterprise_id, context_sources, business_context } = req.body || {};
    const flow = flow_id ? await db.EmeAtendeFlow.findByPk(flow_id) : null;
    const probe = {
        cv_enterprise_id: cv_enterprise_id !== undefined ? cv_enterprise_id : (flow?.cv_enterprise_id ?? null),
        context_sources: context_sources !== undefined ? context_sources : (flow?.context_sources ?? null),
        business_context: business_context !== undefined ? business_context : (flow?.business_context ?? null),
    };
    const { text, meta } = await EmeAtendeContextBuilder.fullContext(probe);
    res.json({ text, meta });
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

/** Muda o estado (bot|closed) - pausa/encerra ou devolve pro bot. */
router.put('/conversations/:id/state', wrap(async (req, res) => {
    const state = String(req.body?.state || '');
    if (!['bot', 'closed'].includes(state)) {
        return res.status(400).json({ error: 'state deve ser bot|closed.' });
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

    // Mesmo prompt do atendimento real (persona + contexto CV/ficha ao vivo +
    // imagens + regras duras) - o sandbox testa o que vai pro ar de verdade.
    const fakeLead = {
        name: req.body?.lead_name || 'Lead de Teste',
        source: 'sandbox',
        campaign: null,
        empreendimento: req.body?.empreendimento || null,
    };
    const { systemPrompt: basePrompt, contextText } =
        await EmeAtendeConversationEngine.buildPromptParts(flow, fakeLead);
    const systemPrompt = `${basePrompt}\n(Modo sandbox de teste - nenhuma mensagem é enviada.)`;
    const hasImages = EmeAtendeConversationEngine.validImages(flow).length > 0;

    const result = await runChat({
        systemPrompt,
        history: history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        userMessage: String(message),
        functionDeclarations: hasImages
            ? [...EmeAtendeConversationEngine.FUNCTION_DECLARATIONS, EmeAtendeConversationEngine.IMAGE_TOOL]
            : EmeAtendeConversationEngine.FUNCTION_DECLARATIONS,
        onTool: async () => ({ ok: true, info: 'sandbox - ação simulada' }),
    });
    // Mesma conferência do atendimento real, mas aqui só REPORTA (não reescreve):
    // o objetivo do sandbox é você ver o que a trava pegaria antes de ligar.
    const cfg = await EmeAtendeSettingsService.getConfig();
    const suspicious = findUnsupported(result.text, contextText, cfg.validation_level);

    res.json({
        reply: result.text,
        tool_calls: result.toolCalls,
        validation: {
            level: cfg.validation_level,
            ok: suspicious.length === 0,
            suspicious,
            note: suspicious.length
                ? 'No atendimento real a Eme reescreveria a resposta sem esses valores; se insistisse, mandaria a mensagem de "vou confirmar e retorno".'
                : null,
        },
    });
}));

export default router;
