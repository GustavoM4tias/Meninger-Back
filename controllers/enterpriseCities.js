// src/controllers/enterpriseCities.js
import {
    syncFromCRM,
    syncFromSiengeCostCenters, // <<-- NOVO
    listEnterpriseCities, updateCityOverride, resolveCity
} from '../services/cityMappingService.js';

export const syncCRM = async (req, res) => {
    try {
        const out = await syncFromCRM();
        res.status(200).json({ ok: true, ...out });
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Falha ao sincronizar CRM' });
    }
};

export const syncERP = async (req, res) => {
    try {
        // permite passar ?limit=300 se quiser
        const limit = req.query.limit ? Number(req.query.limit) : 200;
        const maxCount = req.query.maxCount ? Number(req.query.maxCount) : undefined;
        const verbose = String(req.query.log || '').toLowerCase() === 'verbose';
        const out = await syncFromSiengeCostCenters({ limit, maxCount, verbose });
        res.status(200).json(out);
    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: 'Falha ao sincronizar ERP (Sienge)' });
    }
};

export const listCities = async (req, res) => {
    try {
        const { q, page, pageSize, source, hasOverride, includeRaw } = req.query;
        const out = await listEnterpriseCities({
            q,
            page: page ? Number(page) : 1,
            pageSize: pageSize ? Number(pageSize) : 50,
            source,
            hasOverride: hasOverride === 'true' ? true : hasOverride === 'false' ? false : undefined,
            includeRaw: String(includeRaw || '').toLowerCase() === 'true'
        });
        res.status(200).json(out);
    } catch (e) {
        res.status(500).json({ error: 'Erro ao listar vínculos' });
    }
};

export const setOverride = async (req, res) => {
    try {
        const { id } = req.params;
        const { city_override } = req.body;
        const out = await updateCityOverride({ id, city_override });
        res.status(200).json({ ok: true, ...out });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
};

export const resolveCityController = async (req, res) => {
    try {
        const { crm_id, erp_id } = req.query;
        if (!crm_id && !erp_id) return res.status(400).json({ error: 'Informe crm_id ou erp_id' });
        const city = await resolveCity({ crm_id: crm_id ? Number(crm_id) : undefined, erp_id });
        res.status(200).json({ city });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao resolver cidade' });
    }
};
