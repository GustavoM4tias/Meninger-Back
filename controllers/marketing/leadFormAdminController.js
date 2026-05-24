// controllers/marketing/leadFormAdminController.js
//
// CRUD admin dos formulários de captação (lead_forms).

import db from '../../models/sequelize/index.js';

const { LeadForm } = db;

// Campos editáveis (slug é definido só na criação).
const EDITABLE = [
    'name', 'active', 'fields', 'fields_config', 'page_config',
    'bound_empreendimentos', 'midia_slug', 'cv_origem', 'tags',
    'consent_required', 'consent_text', 'consent_text_version',
    'allowed_origins', 'redirect_url',
];

export async function listLeadForms(req, res) {
    try {
        const forms = await LeadForm.findAll({ order: [['id', 'DESC']] });
        return res.json({ ok: true, results: forms });
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

export default { listLeadForms, createLeadForm, updateLeadForm };
