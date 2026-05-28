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

/** Lista últimos leads que entraram por esse meta_form_id. */
export async function recentLeads(req, res) {
    try {
        const { id } = req.params;
        const limit = Math.min(Number(req.query.limit) || 20, 1000);
        let withCv = null;
        if (req.query.cv === 'matched')   withCv = true;
        if (req.query.cv === 'unmatched') withCv = false;
        const leads = await MetaLeadFormService.listRecentLeads(id, { limit, withCv });
        return res.json({ ok: true, results: leads });
    } catch (err) {
        console.error(`❌ [meta-forms] recentLeads: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Comparativo Meta × Office × CV pra esse form. */
export async function comparison(req, res) {
    try {
        const { id } = req.params;
        const data = await MetaLeadFormService.getComparison(id);
        return res.json({ ok: true, ...data });
    } catch (err) {
        console.error(`❌ [meta-forms] comparison: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Exporta CSV dos leads desse form. */
export async function exportCsv(req, res) {
    try {
        const { id } = req.params;
        let withCv = null;
        if (req.query.cv === 'matched')   withCv = true;
        if (req.query.cv === 'unmatched') withCv = false;
        const csv = await MetaLeadFormService.exportLeadsCsv(id, { withCv });

        const filename = `leads-meta-${id}-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        // BOM pra Excel ler UTF-8 corretamente.
        return res.send('﻿' + csv);
    } catch (err) {
        console.error(`❌ [meta-forms] exportCsv: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Retorna o editor de field mapping (perguntas + mapping atual + opções). */
export async function fieldMappingEditor(req, res) {
    try {
        const data = await MetaLeadFormService.getFieldMappingEditor(req.params.id);
        return res.json({ ok: true, ...data });
    } catch (err) {
        console.error(`❌ [meta-forms] fieldMappingEditor: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

/** Salva os field_mappings do form. Body: { mappings: { questionKey: cvField } } */
export async function updateFieldMappings(req, res) {
    try {
        const mappings = req.body?.mappings || {};
        const updated = await MetaLeadFormService.updateFieldMappings(req.params.id, mappings);
        return res.json({ ok: true, form: updated });
    } catch (err) {
        console.error(`❌ [meta-forms] updateFieldMappings: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message });
    }
}

export default {
    list, sync, updateMapping, recentLeads, comparison, exportCsv,
    fieldMappingEditor, updateFieldMappings,
};
