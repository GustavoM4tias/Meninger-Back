// controllers/marketing/metaLeadFormController.js
//
// Endpoints admin pros Lead Forms da Meta cacheados localmente e seu mapping.

import MetaLeadFormService from '../../services/marketing/MetaLeadFormService.js';

export async function list(req, res) {
    try {
        const forms = await MetaLeadFormService.getAll();
        return res.json({ ok: true, results: forms });
    } catch (err) {
        console.error(`❌ [meta-forms] list: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Erro ao carregar formulários Meta.' });
    }
}

export async function sync(req, res) {
    try {
        const result = await MetaLeadFormService.syncFromMeta();
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [meta-forms] sync: ${err.message}`);
        const detail = err?.response?.data?.error?.message || err.message;
        return res.status(500).json({
            ok: false,
            error: `Erro ao sincronizar com a Meta: ${detail}`,
            hint: detail.includes('permission') || detail.includes('Permission')
                ? 'Confirme que o token tem as permissões pages_show_list + pages_read_engagement + leads_retrieval e que as Páginas estão atribuídas ao System User.'
                : null,
        });
    }
}

export async function updateMapping(req, res) {
    try {
        const { id } = req.params;
        const patch = req.body || {};
        const updated = await MetaLeadFormService.updateMapping(id, patch);
        return res.json({ ok: true, form: updated });
    } catch (err) {
        console.error(`❌ [meta-forms] updateMapping: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

export default { list, sync, updateMapping };
