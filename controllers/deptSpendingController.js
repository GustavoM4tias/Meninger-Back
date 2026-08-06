// src/controllers/deptSpendingController.js
//
// Tela "Gastos por Departamento" (reestruturação da Viabilidade de Marketing).
// Governança: a diretoria (não-admin) só recebe empreendimentos LIBERADOS; o
// admin recebe tudo (rascunho + liberado) para ajustar no backoffice.

import DeptSpendingService from '../services/deptSpending/deptSpendingService.js';
import { getReportInsights } from '../services/deptSpending/deptSpendingInsightService.js';
import { getScope, isErpAllowed } from '../services/permissions/accessScopeService.js';

const service = new DeptSpendingService();

function normYM(v) {
    const ym = String(v || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`month inválido: ${v}`);
    return ym;
}

/* Empresa (Sienge) visível no escopo? Direto por companyIds ou pela heurística
   de prefixo (os CCs do Sienge começam com o id da empresa: 10601 → 106). */
function companyAllowedByScope(scope, companyId) {
    if (!scope || scope.all) return true;
    const cid = Number(companyId);
    if (!Number.isFinite(cid)) return false;
    if ((scope.companyIds || []).includes(cid)) return true;
    const prefix = String(cid);
    return (scope.erpIds || []).some((cc) => String(cc).startsWith(prefix));
}

export async function getEnterpriseSpending(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const { erpId } = req.params;
        const { year, aliasId = 'default', month } = req.query;

        // Escopo de acesso: não-admin só consulta CC do seu escopo (fail-closed)
        const scope = await getScope(req.user);
        if (!scope.all && !isErpAllowed(scope, erpId)) {
            return res.status(403).json({ error: 'Centro de custo fora do seu escopo.' });
        }

        const start_month = req.query.start_month ? normYM(req.query.start_month) : null;
        const end_month = req.query.end_month ? normYM(req.query.end_month) : null;

        const parsedYear = year ? Number(year) : null;
        if (!start_month && !end_month) {
            if (!parsedYear || parsedYear < 2000) return res.status(400).json({ error: 'Parâmetro year inválido.' });
        } else {
            if (!start_month || !end_month) return res.status(400).json({ error: 'Envie start_month e end_month juntos.' });
        }

        const data = await service.computeEnterpriseViability({
            year: parsedYear,
            upToMonth: month ? normYM(month) : null,
            startMonth: start_month,
            endMonth: end_month,
            aliasId,
            erpId,
        });

        return res.json(data);
    } catch (e) {
        console.error('[DeptSpendingController] getEnterpriseSpending: erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao calcular gastos por departamento.' });
    }
}

/* Relatório Gerencial de Investimento de 1 EMPREENDIMENTO (etapa/CC da projeção).
   `key` = enterprise_key; um id de empresa Sienge ainda é aceito (links antigos) e
   devolve a SPE inteira somada. Diretoria (não-admin) só acessa CONFIGURADOS +
   LIBERADOS. */
export async function getCompanyReport(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const key = String(req.params.key || '').trim();
        if (!key) return res.status(400).json({ error: 'Empreendimento inválido.' });

        const month = normYM(req.query.month || new Date().toISOString().slice(0, 7));
        const isAdmin = req.user?.role === 'admin';

        const report = await service.computeCompanyReport({
            key,
            refMonth: month,
            aliasId: req.query.aliasId || 'default',
        });

        // Escopo de acesso: não-admin só consulta empreendimento do seu escopo
        // (fail-closed; mesma resposta da governança para não vazar existência)
        const scope = await getScope(req.user);
        const ccs = report.company?.costCenterIds || [];
        const inScope = scope.all
            || companyAllowedByScope(scope, report.company?.companyId)
            || ccs.some((cc) => isErpAllowed(scope, cc));
        if (!inScope) return res.status(404).json({ error: 'Relatório não disponível.' });

        // Governança: fora do backoffice, rascunho/não-configurado não existe.
        if (!isAdmin && (!report.viability.released || !report.viability.configured)) {
            return res.status(404).json({ error: 'Relatório não disponível.' });
        }

        const insights = await getReportInsights({
            enterpriseKey: report.company?.enterpriseKey || null,
            companyId: report.company?.companyId ?? null,
            report,
        });
        return res.json({ ...report, insights, isAdmin });
    } catch (e) {
        console.error('[DeptSpendingController] getCompanyReport erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao montar o relatório do empreendimento.' });
    }
}

export const getEnterprisesSpending = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const { year, aliasId, month } = req.query;

        const start_month = req.query.start_month ? normYM(req.query.start_month) : null;
        const end_month = req.query.end_month ? normYM(req.query.end_month) : null;

        const parsedYear = year ? Number(year) : null;
        if (!start_month && !end_month) {
            if (!parsedYear || parsedYear < 2000) return res.status(400).json({ error: 'Parâmetro year inválido.' });
        } else {
            if (!start_month || !end_month) return res.status(400).json({ error: 'Envie start_month e end_month juntos.' });
        }

        // Governança: só admin enxerga rascunhos. Diretoria (não-admin) recebe só os liberados.
        const isAdmin = req.user?.role === 'admin';

        // Filtro por empresa (deep link compartilhável): ?company_ids=106,103
        const companyIds = String(req.query.company_ids || '')
            .split(',').map((s) => s.trim()).filter(Boolean)
            .map(Number).filter(Number.isFinite);

        const out = await service.listEnterprisesViability({
            year: parsedYear,
            upToMonth: month ? normYM(month) : null,
            startMonth: start_month,
            endMonth: end_month,
            aliasId: aliasId || 'default',
            onlyReleased: !isAdmin,
            companyIds: companyIds.length ? companyIds : null,
        });

        // Escopo de acesso: não-admin só vê empreendimentos/empresas do seu
        // escopo (fail-closed: escopo vazio → lista vazia)
        const scope = await getScope(req.user);
        if (!scope.all) {
            const results = (out.results || []).filter((r) => {
                if (r.companyId != null && companyAllowedByScope(scope, r.companyId)) return true;
                const ccs = Array.isArray(r.costCenterIds) ? r.costCenterIds : [];
                if (ccs.some((cc) => isErpAllowed(scope, cc))) return true;
                if (r.erpId != null && isErpAllowed(scope, r.erpId)) return true;
                return false;
            });
            return res.json({ ...out, count: results.length, results, isAdmin });
        }

        return res.json({ ...out, isAdmin });
    } catch (e) {
        console.error('[DeptSpendingController] getEnterprisesSpending erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar gastos por departamento' });
    }
};
