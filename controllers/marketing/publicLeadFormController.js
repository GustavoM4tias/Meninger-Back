// controllers/marketing/publicLeadFormController.js
//
// Endpoint PÚBLICO consumido pela landing page hospedada em lp.menin.com.br/<slug>
// e por qualquer integração externa que queira renderizar o formulário dinâmico.
//
// Devolve só o que a página precisa para se renderizar — vínculo (midia, origem,
// empreendimentos) NÃO é exposto, é interno.

import db from '../../models/sequelize/index.js';

import { Op } from 'sequelize';

const { LeadForm, InboundLead } = db;

export async function getPublicLeadForm(req, res) {
    try {
        const form = await LeadForm.findOne({
            where: { slug: req.params.slug },
            attributes: [
                'slug', 'name', 'active',
                'fields_config', 'page_config',
                'consent_required', 'consent_text', 'consent_text_version',
                'redirect_url',
            ],
        });
        if (!form) {
            return res.status(404).json({ ok: false, error: 'Página não encontrada.' });
        }
        if (!form.active) {
            return res.status(410).json({ ok: false, error: 'Esta página de captação foi desativada.', inactive: true });
        }
        // Não expõe o flag `active` na resposta pública (sempre true se chegou aqui).
        const { active, ...rest } = form.get({ plain: true });
        return res.json({ ok: true, form: rest });
    } catch (err) {
        console.error(`❌ [marketing-capture] getPublicLeadForm: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar o formulário.' });
    }
}

// GET /forms/:slug/entries — inscritos de um form "só cadastro" com lista pública
// (telão do sorteio). Só nome e imobiliária; telefone serve apenas para não
// contar a mesma pessoa duas vezes e nunca sai na resposta.
const FEED_TTL_MS = 3000;
const feedCache = new Map();

export async function getPublicFormEntries(req, res) {
    try {
        const slug = req.params.slug;
        const hit = feedCache.get(slug);
        if (hit && Date.now() - hit.at < FEED_TTL_MS) return res.json(hit.body);

        const form = await LeadForm.findOne({ where: { slug }, attributes: ['id', 'cv_skip', 'public_feed'] });
        if (!form || !form.cv_skip || !form.public_feed) {
            return res.status(404).json({ ok: false, error: 'Lista não disponível.' });
        }
        const rows = await InboundLead.findAll({
            where: { source_form_id: form.id, is_spam: false, status: { [Op.ne]: 'spam' } },
            attributes: ['id', 'nome', 'telefone', 'extra_fields', 'created_at'],
            order: [['created_at', 'ASC']],
            limit: 5000,
        });
        const seen = new Set();
        const items = [];
        for (const r of rows) {
            const key = String(r.telefone || '').replace(/\D/g, '').slice(-9) || `id${r.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const nome = String(r.nome || '').trim().replace(/\s+/g, ' ').slice(0, 80);
            if (!nome) continue;
            items.push({
                id: r.id,
                nome,
                imobiliaria: String(r.extra_fields?.imobiliaria || '').trim().slice(0, 80) || null,
                created_at: r.created_at,
            });
        }
        const body = { ok: true, count: items.length, items };
        feedCache.set(slug, { at: Date.now(), body });
        return res.json(body);
    } catch (err) {
        console.error(`❌ [marketing-capture] getPublicFormEntries: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar a lista.' });
    }
}

export default { getPublicLeadForm, getPublicFormEntries };
