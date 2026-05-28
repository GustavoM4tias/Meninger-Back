// controllers/marketing/leadFormAdminController.js
//
// CRUD admin dos formulários de captação (lead_forms) + agregados de leads
// (mesmo padrão dos formulários Meta).

import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';

const { LeadForm, InboundLead } = db;

// Campos editáveis (slug é definido só na criação).
const EDITABLE = [
    // Identificação & estado
    'name', 'active',
    // Form / página
    'fields', 'fields_config', 'page_config',
    // Vínculo CV
    'bound_empreendimentos', 'midia_slug', 'cv_origem', 'tags',
    // LGPD
    'consent_required', 'consent_text', 'consent_text_version',
    // Outros
    'allowed_origins', 'redirect_url',
    // Gestão interna
    'description', 'priority', 'campaign_ref',
    // Programação
    'start_date', 'end_date',
    // UTMs default
    'default_utm_source', 'default_utm_medium', 'default_utm_campaign',
    'default_utm_content', 'default_utm_term',
    // Extras CV
    'cv_extra_fields',
];

/** Anexa stats agregados de inbound_leads (total, 30d, delivered, held, etc.) por form. */
async function attachStats(forms) {
    if (!forms.length) return forms;
    const ids = forms.map(f => f.id);

    const stats = await InboundLead.findAll({
        where: { source_form_id: { [Op.in]: ids } },
        attributes: [
            ['source_form_id', 'source_form_id'],
            [fn('COUNT', col('id')), 'total'],
            [fn('SUM', literal(`CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END`)), 'last_30d'],
            [fn('SUM', literal(`CASE WHEN status = 'delivered' THEN 1 ELSE 0 END`)), 'delivered'],
            [fn('SUM', literal(`CASE WHEN status = 'held'      THEN 1 ELSE 0 END`)), 'held'],
            [fn('SUM', literal(`CASE WHEN status = 'spam'      THEN 1 ELSE 0 END`)), 'spam'],
            [fn('SUM', literal(`CASE WHEN status IN ('failed','rejected') THEN 1 ELSE 0 END`)), 'failed'],
            [fn('MAX', col('created_at')), 'last_lead_at'],
        ],
        group: ['source_form_id'],
        raw: true,
    });

    const byFormId = new Map();
    for (const s of stats) {
        byFormId.set(Number(s.source_form_id), {
            total:        Number(s.total)     || 0,
            last_30d:     Number(s.last_30d)  || 0,
            delivered:    Number(s.delivered) || 0,
            held:         Number(s.held)      || 0,
            spam:         Number(s.spam)      || 0,
            failed:       Number(s.failed)    || 0,
            last_lead_at: s.last_lead_at || null,
        });
    }

    return forms.map(f => {
        const plain = f.get({ plain: true });
        return {
            ...plain,
            stats: byFormId.get(plain.id) || {
                total: 0, last_30d: 0, delivered: 0, held: 0, spam: 0, failed: 0, last_lead_at: null,
            },
        };
    });
}

export async function listLeadForms(req, res) {
    try {
        const forms = await LeadForm.findAll({ order: [['id', 'DESC']] });
        const withStats = await attachStats(forms);
        return res.json({ ok: true, results: withStats });
    } catch (err) {
        console.error(`❌ [marketing-capture] listLeadForms: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao listar formulários.' });
    }
}

export async function createLeadForm(req, res) {
    try {
        const body = req.body || {};
        const slug = String(body.slug || '').trim().toLowerCase();
        if (!/^[a-z0-9-]{2,60}$/.test(slug)) {
            return res.status(400).json({ ok: false, error: 'Slug inválido — use minúsculas, números e hífen (2 a 60 caracteres).' });
        }
        if (!body.name || !String(body.name).trim()) {
            return res.status(400).json({ ok: false, error: 'Informe o nome do formulário.' });
        }
        const exists = await LeadForm.findOne({ where: { slug } });
        if (exists) {
            return res.status(409).json({ ok: false, error: 'Já existe um formulário com esse slug.' });
        }

        const data = { slug };
        for (const k of EDITABLE) if (body[k] !== undefined) data[k] = body[k];
        const form = await LeadForm.create(data);
        return res.status(201).json({ ok: true, form });
    } catch (err) {
        console.error(`❌ [marketing-capture] createLeadForm: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao criar o formulário.' });
    }
}

export async function updateLeadForm(req, res) {
    try {
        const form = await LeadForm.findByPk(req.params.id);
        if (!form) return res.status(404).json({ ok: false, error: 'Formulário não encontrado.' });
        const body = req.body || {};
        for (const k of EDITABLE) if (body[k] !== undefined) form[k] = body[k];
        await form.save();
        return res.json({ ok: true, form });
    } catch (err) {
        console.error(`❌ [marketing-capture] updateLeadForm: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao atualizar o formulário.' });
    }
}

/**
 * Toggle rápido do `active` — endpoint dedicado pra UX da tabela (sem precisar
 * abrir o modal). Aceita { active: boolean } ou alterna o valor atual.
 */
export async function toggleActive(req, res) {
    try {
        const form = await LeadForm.findByPk(req.params.id);
        if (!form) return res.status(404).json({ ok: false, error: 'Formulário não encontrado.' });
        const desired = req.body?.active;
        form.active = typeof desired === 'boolean' ? desired : !form.active;
        await form.save();
        return res.json({ ok: true, form: { id: form.id, active: form.active } });
    } catch (err) {
        console.error(`❌ [marketing-capture] toggleActive: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao alterar status.' });
    }
}

/** Lista últimos N leads que entraram por esse form. */
export async function listLeadFormLeads(req, res) {
    try {
        const formId = Number(req.params.id);
        if (!formId) return res.status(400).json({ ok: false, error: 'ID inválido.' });
        const limit = Math.min(Number(req.query.limit) || 20, 100);

        const leads = await InboundLead.findAll({
            where: { source_form_id: formId },
            attributes: [
                'id', 'nome', 'email', 'telefone', 'channel', 'status',
                'midia_slug', 'cv_origem', 'utm_source', 'utm_campaign',
                'is_spam', 'created_at',
            ],
            order: [['created_at', 'DESC']],
            limit,
        });
        return res.json({ ok: true, results: leads.map(l => l.get({ plain: true })) });
    } catch (err) {
        console.error(`❌ [marketing-capture] listLeadFormLeads: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao listar leads do formulário.' });
    }
}

export default { listLeadForms, createLeadForm, updateLeadForm, toggleActive, listLeadFormLeads };
