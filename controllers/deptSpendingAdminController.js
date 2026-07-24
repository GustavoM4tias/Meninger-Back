// controllers/deptSpendingAdminController.js
//
// Endpoints ADMIN-ONLY de configuração + liberação da tela "Gastos por Departamento".
// Montados com authenticate + requireAdmin em deptSpendingRoutes.js.

import * as cfg from '../services/deptSpending/deptSpendingConfigService.js';
import DeptSpendingService from '../services/deptSpending/deptSpendingService.js';
import { getReportInsights } from '../services/deptSpending/deptSpendingInsightService.js';

const service = new DeptSpendingService();

function actor(req) {
    return req.user?.username || req.user?.email || String(req.user?.id || '');
}

/* ===== Departamentos acompanhados (global) ===== */

export async function getMarketingDepartments(req, res) {
    try {
        const [configured, known] = await Promise.all([
            cfg.listMarketingDepartments(),
            cfg.listKnownDepartments(),
        ]);
        return res.json({ configured, known });
    } catch (e) {
        console.error('[DeptSpendingAdmin] getMarketingDepartments erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar departamentos.' });
    }
}

export async function putMarketingDepartment(req, res) {
    try {
        const { name, is_marketing } = req.body || {};
        const out = await cfg.setMarketingDepartment(name, is_marketing, actor(req));
        return res.json(out);
    } catch (e) {
        console.error('[DeptSpendingAdmin] putMarketingDepartment erro', e);
        return res.status(400).json({ error: e.message || 'Erro ao salvar departamento.' });
    }
}

/* ===== Configuração por empreendimento ===== */

export async function getEnterpriseSettings(req, res) {
    try {
        const rows = await cfg.listEnterpriseSettings();
        return res.json({ results: rows });
    } catch (e) {
        console.error('[DeptSpendingAdmin] getEnterpriseSettings erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar configurações por empreendimento.' });
    }
}

export async function putEnterpriseSettings(req, res) {
    try {
        const { companyId } = req.params;
        const { blocked_considered_available, marketing_dept_overrides, status_override, loja_departments } = req.body || {};
        const out = await cfg.setEnterpriseSettings(
            companyId,
            {
                blockedConsideredAvailable: blocked_considered_available,
                marketingDeptOverrides: marketing_dept_overrides,
                statusOverride: status_override,
                lojaDepartments: loja_departments,
            },
            actor(req)
        );
        return res.json(out);
    } catch (e) {
        console.error('[DeptSpendingAdmin] putEnterpriseSettings erro', e);
        return res.status(400).json({ error: e.message || 'Erro ao salvar configuração do empreendimento.' });
    }
}

/* ===== Liberação (rascunho → liberado) por empreendimento ===== */

/* ===== Relatório: regenerar "Leitura para decisão" (IA) ===== */

export async function regenerateReportInsights(req, res) {
    try {
        const companyId = Number(req.params.companyId);
        if (!Number.isFinite(companyId)) return res.status(400).json({ error: 'companyId inválido.' });
        const month = String(req.query.month || req.body?.month || new Date().toISOString().slice(0, 7)).slice(0, 7);

        const report = await service.computeCompanyReport({ companyId, refMonth: month });
        const insights = await getReportInsights({ companyId, report, force: true });
        return res.json(insights);
    } catch (e) {
        console.error('[DeptSpendingAdmin] regenerateReportInsights erro', e);
        return res.status(400).json({ error: e.message || 'Erro ao regenerar a leitura para decisão.' });
    }
}

export async function putEnterpriseRelease(req, res) {
    try {
        const { companyId } = req.params;
        const { is_released, notes } = req.body || {};
        const out = await cfg.setEnterpriseRelease(
            companyId,
            { isReleased: is_released, notes },
            actor(req)
        );
        return res.json(out);
    } catch (e) {
        console.error('[DeptSpendingAdmin] putEnterpriseRelease erro', e);
        return res.status(400).json({ error: e.message || 'Erro ao liberar empreendimento.' });
    }
}
