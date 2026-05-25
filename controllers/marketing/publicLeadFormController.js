// controllers/marketing/publicLeadFormController.js
//
// Endpoint PÚBLICO consumido pela landing page hospedada em lp.menin.com.br/<slug>
// e por qualquer integração externa que queira renderizar o formulário dinâmico.
//
// Devolve só o que a página precisa para se renderizar — vínculo (midia, origem,
// empreendimentos) NÃO é exposto, é interno.

import db from '../../models/sequelize/index.js';

const { LeadForm } = db;

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

export default { getPublicLeadForm };
