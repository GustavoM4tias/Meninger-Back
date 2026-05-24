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
            where: { slug: req.params.slug, active: true },
            attributes: [
                'slug', 'name',
                'fields_config', 'page_config',
                'consent_required', 'consent_text', 'consent_text_version',
                'redirect_url',
            ],
        });
        if (!form) {
            return res.status(404).json({ ok: false, error: 'Formulário não encontrado ou inativo.' });
        }
        return res.json({ ok: true, form });
    } catch (err) {
        console.error(`❌ [marketing-capture] getPublicLeadForm: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar o formulário.' });
    }
}

export default { getPublicLeadForm };
