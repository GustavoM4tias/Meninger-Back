// controllers/viabilityAdminController.js
//
// Endpoints ADMIN-ONLY de configuração da Viabilidade de Marketing.
// Montados com authenticate + requireAdmin em viabilityRoutes.js.

import * as cfg from '../services/viability/viabilityConfigService.js';

function actor(req) {
    return req.user?.username || req.user?.email || String(req.user?.id || '');
}

/* ===== Departamentos de marketing (global) ===== */

export async function getMarketingDepartments(req, res) {
    try {
        const [configured, known] = await Promise.all([
            cfg.listMarketingDepartments(),
            cfg.listKnownDepartments(),
        ]);
        return res.json({ configured, known });
    } catch (e) {
        console.error('[ViabilityAdmin] getMarketingDepartments erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar departamentos de marketing.' });
    }
}

export async function putMarketingDepartment(req, res) {
    try {
        const { name, is_marketing } = req.body || {};
        const out = await cfg.setMarketingDepartment(name, is_marketing, actor(req));
        return res.json(out);
    } catch (e) {
        console.error('[ViabilityAdmin] putMarketingDepartment erro', e);
        return res.status(400).json({ error: e.message || 'Erro ao salvar departamento de marketing.' });
    }
}

/* ===== Configuração por empreendimento ===== */

export async function getEnterpriseSettings(req, res) {
    try {
        const rows = await cfg.listEnterpriseSettings();
        return res.json({ results: rows });
    } catch (e) {
        console.error('[ViabilityAdmin] getEnterpriseSettings erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar configurações por empreendimento.' });
    }
}

export async function putEnterpriseSettings(req, res) {
    try {
        const { companyId } = req.params;
        const { blocked_considered_available, marketing_dept_overrides } = req.body || {};
        const out = await cfg.setEnterpriseSettings(
            companyId,
            {
                blockedConsideredAvailable: blocked_considered_available,
                marketingDeptOverrides: marketing_dept_overrides,
            },
            actor(req)
        );
        return res.json(out);
    } catch (e) {
        console.error('[ViabilityAdmin] putEnterpriseSettings erro', e);
        return res.status(400).json({ error: e.message || 'Erro ao salvar configuração do empreendimento.' });
    }
}
