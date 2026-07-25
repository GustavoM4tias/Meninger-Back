// src/services/deptSpending/deptSpendingService.js
//
// Motor de cálculo da tela "Gastos por Departamento" (company-level).
//
// Reestruturação da antiga Viabilidade de Marketing. Mesmo motor, com duas mudanças
// de Fase 1 (definidas com o usuário):
//  1. O Custo Loja SAIU do orçamento (será readicionado numa fase futura).
//     Orçamento = totalUnits × ticketMédio × %marketing (sem + custoLoja).
//  2. Governança "rascunho → liberado" por empreendimento: a diretoria (não-admin)
//     só enxerga empreendimentos liberados; o admin vê tudo (rascunho + liberado).
//
// Unidade de análise = EMPRESA Sienge (= empreendimento). Vários centros de custo
// (CCs) podem pertencer à mesma empresa. O agrupamento usa
// enterprise_cities.raw_payload.idCompany (mesma fonte do Custos ao vivo).
//
// Regras remanescentes (inalteradas):
//  - Custo planejado/unidade = orçamento / totalUnits.
//  - Gasto = despesas dos CCs da empresa, SOMENTE departamentos acompanhados
//    (config admin global + exceções por empresa), competência ≤ mês.
//  - Saldo = orçamento − gasto; saldo/unidade a vender = saldo / inventário.
//  - Recomendado do mês = saldo/unidade × meta de unidades do mês (diluição).
//  - Unidades: reservada conta como disponível; bloqueada NÃO conta por padrão
//    (admin libera N por empresa); vendida sai do estoque a vender.

import db from '../../models/sequelize/index.js';
import { resolveUnitsForErp } from '../cv/enterpriseUnitsSummaryService.js';
import { buildSpendingResolver } from './deptSpendingConfigService.js';
import { listMarketingSpendByMonth } from '../sienge/payableLiveService.js';

const {
    SalesProjection,
    SalesProjectionLine,
    SalesProjectionEnterprise,
    EnterpriseCity,
    Sequelize,
} = db;

const { Op } = Sequelize;

/* ========================= Helpers de período (YM) ========================= */
function normYM(v) {
    const ym = String(v || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`year_month inválido: ${v}`);
    return ym;
}
function ymToDateStart(ym) {
    return `${ym}-01`;
}
function nextYm(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    d.setUTCMonth(d.getUTCMonth() + 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function prevYm(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function buildYmRange(startYm, endYm) {
    const start = normYM(startYm);
    const end = normYM(endYm);
    if (start > end) throw new Error('start_month não pode ser maior que end_month');
    const out = [];
    let cur = start;
    while (cur <= end) {
        out.push(cur);
        cur = nextYm(cur);
    }
    return out;
}
function resolveRange({ year, upToMonth, startMonth, endMonth }) {
    if (startMonth && endMonth) {
        const start = normYM(startMonth);
        const end = normYM(endMonth);
        if (start > end) throw new Error('start_month não pode ser maior que end_month');
        return { startMonth: start, endMonth: end };
    }
    const y = Number(year);
    if (!y || y < 2000) throw new Error('year inválido');
    const start = `${y}-01`;
    const end = upToMonth ? normYM(upToMonth) : `${y}-12`;
    if (start > end) throw new Error('range inválido para year/month');
    return { startMonth: start, endMonth: end };
}

const num = (v) => Number(v || 0);

export default class DeptSpendingService {
    async getActiveProjection() {
        const proj = await SalesProjection.findOne({
            where: { is_active: true },
            order: [['updated_at', 'DESC']],
        });
        if (!proj) throw new Error('Nenhuma projeção ativa encontrada.');
        return proj;
    }

    /* Carrega defaults + lines (no range) da projeção ativa, indexados por enterprise_key. */
    async loadProjectionAggregates({ projectionId, aliasId = 'default', startYM, endYM }) {
        const defaults = await SalesProjectionEnterprise.findAll({
            where: { projection_id: projectionId, alias_id: String(aliasId) },
            order: [['enterprise_name_cache', 'ASC'], ['enterprise_key', 'ASC']],
        });

        const lines = await SalesProjectionLine.findAll({
            where: {
                projection_id: projectionId,
                alias_id: String(aliasId),
                year_month: { [Op.between]: [startYM, endYM] },
            },
            order: [['enterprise_key', 'ASC'], ['year_month', 'ASC']],
        });

        const linesByKey = new Map();
        for (const l of lines) {
            const k = String(l.enterprise_key);
            if (!linesByKey.has(k)) linesByKey.set(k, []);
            linesByKey.get(k).push(l);
        }

        // Soma de unidades e receita projetadas em TODA a projeção (todos os meses),
        // por enterprise_key — fallback de "total de unidades" / ticket para empresas
        // sem mapa de unidades no CV.
        const fullRows = await db.sequelize.query(
            `SELECT enterprise_key,
                    COALESCE(SUM(units_target),0) AS units,
                    COALESCE(SUM(units_target * avg_price_target),0) AS revenue
               FROM sales_projection_lines
              WHERE projection_id = :pid AND alias_id = :alias
              GROUP BY enterprise_key`,
            { replacements: { pid: projectionId, alias: String(aliasId) }, type: db.Sequelize.QueryTypes.SELECT }
        );
        const fullByKey = new Map(
            fullRows.map((r) => [String(r.enterprise_key), { units: Number(r.units || 0), revenue: Number(r.revenue || 0) }])
        );

        // Unidades projetadas do mês selecionado em diante (futuro/atual) — p/ status do empreendimento.
        const futureRows = await db.sequelize.query(
            `SELECT enterprise_key, COALESCE(SUM(units_target),0) AS units
               FROM sales_projection_lines
              WHERE projection_id = :pid AND alias_id = :alias AND year_month >= :endYM
              GROUP BY enterprise_key`,
            { replacements: { pid: projectionId, alias: String(aliasId), endYM }, type: db.Sequelize.QueryTypes.SELECT }
        );
        const futureByKey = new Map(futureRows.map((r) => [String(r.enterprise_key), Number(r.units || 0)]));

        return { defaults: defaults.map((d) => d.toJSON()), linesByKey, fullByKey, futureByKey };
    }

    /* erp_id (CC) -> { companyId, companyName } via enterprise_cities (idCompany do Sienge). */
    async mapErpsToCompany(erpIds) {
        const out = new Map();
        const ids = [...new Set((erpIds || []).map((e) => String(e)).filter(Boolean))];
        if (!ids.length) return out;

        const rows = await db.sequelize.query(
            `SELECT ec.erp_id,
                    NULLIF(ec.raw_payload->>'idCompany','')::int AS company_id,
                    COALESCE(
                        NULLIF(ec.raw_payload->>'companyName',''),
                        NULLIF(ec.enterprise_name,'')
                    ) AS company_name
               FROM enterprise_cities ec
              WHERE ec.source = 'erp' AND ec.erp_id IN (:ids)`,
            { replacements: { ids }, type: db.Sequelize.QueryTypes.SELECT }
        );
        for (const r of rows) {
            out.set(String(r.erp_id), {
                companyId: r.company_id != null ? Number(r.company_id) : null,
                companyName: r.company_name || null,
            });
        }
        return out;
    }

    async resolveCvEnterpriseId(erpId) {
        if (!erpId) return undefined;
        try {
            const row = await EnterpriseCity.findOne({
                where: { source: 'crm', erp_id: String(erpId) },
                attributes: ['crm_id'],
            });
            return row?.crm_id != null ? Number(row.crm_id) : undefined;
        } catch (e) {
            console.error('[DeptSpending] resolveCvEnterpriseId erro', e);
            return undefined;
        }
    }

    /* Soma o snapshot de unidades dos CCs da empresa usando a COLETA UNIFICADA do serviço
       de CV (resolveUnitsForErp) — exatamente a MESMA da tela de Projeção. CCs em paralelo. */
    async summarizeCompanyUnits(erpIds) {
        const acc = {
            totalUnits: 0, soldUnitsStock: 0, reservedUnits: 0,
            blockedUnits: 0, availableUnits: 0,
        };
        const keys = [...new Set((erpIds || []).map((e) => String(e)).filter(Boolean))];
        const summaries = await Promise.all(keys.map((k) => resolveUnitsForErp(k).catch(() => null)));
        for (const s of summaries) {
            if (!s) continue;
            acc.totalUnits += num(s.totalUnits);
            acc.soldUnitsStock += num(s.soldUnitsStock ?? s.soldUnits);
            acc.reservedUnits += num(s.reservedUnits);
            acc.blockedUnits += num(s.blockedUnits);
            acc.availableUnits += num(s.availableUnits);
        }
        return acc;
    }

    /* Despesas acompanhadas dos CCs, vida toda até endDate, por mês. Filtra por
       departamento acompanhado (resolver). Com `prefetch.spendByCc` (lista) usa as
       linhas já buscadas em UMA query p/ todas as empresas — zero I/O aqui. */
    async loadExpensesLifetimeByMonth({ costCenterIds, endDate, resolver, companyId, prefetch = null }) {
        const byMonth = new Map();
        const ids = (costCenterIds || []).map(Number).filter((n) => Number.isFinite(n));
        if (!ids.length) return { byMonth, total: 0, firstYm: null };

        // Lê AO VIVO do backup do Sienge (agregado por mês de competência + departamento).
        const rows = prefetch?.spendByCc
            ? ids.flatMap((id) => prefetch.spendByCc.get(id) || [])
            : await listMarketingSpendByMonth({ costCenterIds: ids, endDate });

        let total = 0;
        let firstYm = null;
        for (const r of rows) {
            if (!resolver.isMarketing(r.departmentName, companyId)) continue;
            const ym = r.ym; // 'YYYY-MM'
            const amount = num(r.amount);
            byMonth.set(ym, (byMonth.get(ym) || 0) + amount);
            total += amount;
            if (!firstYm || ym < firstYm) firstYm = ym;
        }
        return { byMonth, total, firstYm };
    }

    /* Linhas cruas de contratos (com o ERP em cada linha) p/ vários CCs numa query só. */
    async fetchSalesRows({ erpIds, endDate }) {
        const ids = [...new Set((erpIds || []).map((e) => String(e)).filter(Boolean))];
        if (!ids.length) return [];
        return await db.sequelize.query(
            `SELECT c.enterprise_id::text AS erp,
                    to_char(c.financial_institution_date, 'YYYY-MM') AS ym,
                    c.units
               FROM contracts c
              WHERE c.enterprise_id::text IN (:ids)
                AND c.financial_institution_date < :end
                AND c.situation IN ('Emitido','Autorizado')`,
            { replacements: { ids, end: endDate }, type: db.Sequelize.QueryTypes.SELECT }
        );
    }

    /* Vendas (unidades) realizadas dos CCs até endDate, por mês. Com `prefetch.salesByErp`
       usa as linhas já buscadas em UMA query p/ todas as empresas. */
    async loadSalesLifetimeByMonth({ erpIds, endDate, prefetch = null }) {
        const byMonth = new Map();
        const ids = [...new Set((erpIds || []).map((e) => String(e)).filter(Boolean))];
        if (!ids.length) return { byMonth, total: 0 };

        const rows = prefetch?.salesByErp
            ? ids.flatMap((id) => prefetch.salesByErp.get(id) || [])
            : await this.fetchSalesRows({ erpIds: ids, endDate });

        let total = 0;
        for (const r of rows) {
            const units = Array.isArray(r.units) ? (r.units.length || 1) : 1;
            byMonth.set(r.ym, (byMonth.get(r.ym) || 0) + units);
            total += units;
        }
        return { byMonth, total };
    }

    /* ============================ Núcleo: 1 empresa ============================ */
    async computeCompanyViability({ company, projection, range, resolver, prefetch = null }) {
        const { startYM, endYM, ymList, endDate } = range;
        const ccRows = company.ccRows; // defaults da projeção dos CCs da empresa
        const erpIds = ccRows.map((r) => r.erp_id).filter(Boolean).map(String);
        const costCenterIds = erpIds.map(Number).filter((n) => Number.isFinite(n));

        // ----- Projeção agregada (ticket, %, meta mensal, total manual) -----
        let unitsTargetTotal = 0;       // soma das metas de unidade no período (p/ ticket ponderado)
        let revenueTarget = 0;          // soma units×price no período
        const unitsTargetByMonth = {};
        ymList.forEach((ym) => { unitsTargetByMonth[ym] = 0; });

        let pct = 0;
        let projectionTotalUnits = 0;
        let custoLoja = 0;              // ainda somado p/ referência, mas FORA do orçamento (Fase 1)
        let blockedConsideredRaw = 0;
        let defaultPriceFallback = 0;

        for (const r of ccRows) {
            custoLoja += num(r.custo_loja);
            blockedConsideredRaw += num(r.blocked_considered_available);
            if (r.total_units != null) projectionTotalUnits += num(r.total_units);
            if (!defaultPriceFallback && num(r.default_avg_price) > 0) defaultPriceFallback = num(r.default_avg_price);
            if (pct === 0 && num(r.default_marketing_pct) > 0) pct = num(r.default_marketing_pct);

            for (const l of (company.linesByKey.get(String(r.enterprise_key)) || [])) {
                const ym = String(l.year_month).slice(0, 7);
                if (!(ym in unitsTargetByMonth)) continue;
                const u = num(l.units_target);
                const p = num(l.avg_price_target);
                unitsTargetByMonth[ym] += u;
                unitsTargetTotal += u;
                revenueTarget += u * p;
                if (pct === 0 && num(l.marketing_pct) > 0) pct = num(l.marketing_pct);
            }
        }

        // total de unidades/receita projetadas em TODA a projeção (fallback p/ empresas sem CV)
        let projectionFullUnits = 0;
        let projectionFullRevenue = 0;
        let projectedUnitsFuture = 0;
        for (const r of ccRows) {
            const f = company.fullByKey?.get(String(r.enterprise_key));
            if (f) { projectionFullUnits += num(f.units); projectionFullRevenue += num(f.revenue); }
            projectedUnitsFuture += num(company.futureByKey?.get(String(r.enterprise_key)));
        }

        // ticket médio: ponderado pelo período; senão pela projeção inteira; senão default
        const avgTicket = unitsTargetTotal > 0 ? (revenueTarget / unitsTargetTotal)
            : projectionFullUnits > 0 ? (projectionFullRevenue / projectionFullUnits)
            : defaultPriceFallback;

        // ----- Cargas independentes em PARALELO: unidades CV + gasto + vendas reais -----
        // Com prefetch (lista), gasto/vendas viram agregação em memória (zero I/O).
        const [units, spendRes, salesRes] = await Promise.all([
            this.summarizeCompanyUnits(erpIds),
            this.loadExpensesLifetimeByMonth({ costCenterIds, endDate, resolver, companyId: company.companyId, prefetch }),
            this.loadSalesLifetimeByMonth({ erpIds, endDate, prefetch }),
        ]);

        // "bloqueadas consideradas disponíveis" vem da PROJEÇÃO (por CC, somado).
        const blockedConsidered = Math.min(blockedConsideredRaw, units.blockedUnits);

        // ----- Base de orçamento -----
        // total de unidades: total manual da projeção > snapshot do CV > soma da projeção
        const totalUnits = projectionTotalUnits > 0 ? projectionTotalUnits
            : units.totalUnits > 0 ? units.totalUnits
                : projectionFullUnits;
        // FASE 1: Custo Loja NÃO entra no orçamento (será readicionado depois).
        const budgetTotal = totalUnits * avgTicket * (pct / 100);
        const plannedCostPerUnit = totalUnits > 0 ? budgetTotal / totalUnits : 0;

        // ----- Gasto acompanhado (vida toda até o mês) -----
        const { byMonth: spentByMonth, total: spentTotal, firstYm: firstSpendYm } = spendRes;

        // ----- Vendas realizadas (vida toda até o mês) -----
        const { byMonth: soldByMonth, total: soldUnitsRealYtd } = salesRes;

        // ----- Boletagem: vendidas no CV que ainda não assinaram a instituição financeira -----
        const boletagemUnits = Math.max(0, num(units.soldUnitsStock) - num(soldUnitsRealYtd));

        // ----- Estoque disponível p/ acompanhamento -----
        const cvAvailable = units.availableUnits + units.reservedUnits + blockedConsidered + boletagemUnits;
        const projectionRemaining = Math.max(0, projectionFullUnits - soldUnitsRealYtd);
        const availableInventory = units.totalUnits > 0 ? cvAvailable : projectionRemaining;

        // ----- Derivados -----
        const saldo = budgetTotal - spentTotal;                 // pode ser negativo (estourou)
        const pctInvested = budgetTotal > 0 ? spentTotal / budgetTotal : 0;
        const saldoPerUnit = availableInventory > 0 ? saldo / availableInventory : 0;
        const currentRealCostPerUnit = soldUnitsRealYtd > 0 ? spentTotal / soldUnitsRealYtd : 0;
        const remainingUnitsPlan = availableInventory;

        // ----- Pivô passado × futuro (tela nova) -----
        // PARA TRÁS: gasto acumulado = spentTotal (vida toda até o mês selecionado).
        // PARA FRENTE: unidades a comercializar = projeção futura (meses >= mês) se
        // houver; senão o estoque disponível no CV. Guarda a fonte p/ a UI.
        const futureUnitsSource = projectedUnitsFuture > 0 ? 'projecao'
            : (availableInventory > 0 ? 'estoque' : 'none');
        const futureUnits = projectedUnitsFuture > 0 ? projectedUnitsFuture : availableInventory;
        const futureRevenue = futureUnits * avgTicket;                       // VGV a realizar (futuro)
        const recommendedPerFutureUnit = futureUnits > 0 ? saldo / futureUnits : 0;

        // média mensal de gasto (referência) e gasto do mês corrente
        const monthsElapsed = firstSpendYm ? buildYmRange(firstSpendYm, endYM).length : 0;
        const avgMonthlySpend = monthsElapsed > 0 ? spentTotal / monthsElapsed : 0;
        const monthSpent = spentByMonth.get(endYM) || 0;
        const prevMonthSpent = spentByMonth.get(prevYm(endYM)) || 0;

        // tendência: gasto do mês vs média (negativo = gastando menos = melhorando)
        const trendVsAvg = monthSpent - avgMonthlySpend;
        const trendVsPrev = monthSpent - prevMonthSpent;
        const trendDirection = monthSpent < avgMonthlySpend ? 'improving'
            : monthSpent > avgMonthlySpend ? 'worsening' : 'flat';

        // ----- Contexto do mês selecionado (diluição do saldo nos próximos meses) -----
        const unitsTargetMonth = unitsTargetByMonth[endYM] || 0;
        const unitsSoldRealMonth = soldByMonth.get(endYM) || 0;
        const recommendedMonth = saldoPerUnit * unitsTargetMonth;
        const plannedBudgetMonth = plannedCostPerUnit * unitsTargetMonth;
        const monthContext = {
            yearMonth: endYM,
            unitsTargetMonth,
            unitsSoldRealMonth,
            plannedBudgetMonth,
            adjustedBudgetMonth: recommendedMonth,
            spentMonth: monthSpent,
            remainingBudgetMonth: recommendedMonth - monthSpent,
            monthBudget: recommendedMonth,
            monthSpent,
            monthRemaining: recommendedMonth - monthSpent,
        };

        // ----- Série mensal (no range) p/ gráficos/tendência -----
        const months = ymList.map((ym) => {
            const target = unitsTargetByMonth[ym] || 0;
            const spent = spentByMonth.get(ym) || 0;
            const recommended = saldoPerUnit * target;
            return {
                yearMonth: ym,
                unitsTarget: target,
                unitsSoldReal: soldByMonth.get(ym) || 0,
                recommendedBudget: recommended,
                spent,
                diff: spent - recommended,
                status: spent > recommended ? 'OVER' : spent < recommended ? 'UNDER' : 'ON_TRACK',
            };
        });

        // ----- Status / categoria do empreendimento -----
        const hasFuture = projectedUnitsFuture > 0;
        const pastUnits = Math.max(0, projectionFullUnits - projectedUnitsFuture);
        const hasStarted = soldUnitsRealYtd > 0 || pastUnits > 0;
        const autoStatus = (availableInventory <= 0 && !hasFuture) ? 'concluido'
            : (hasFuture && !hasStarted) ? (spentTotal > 0 ? 'pre_lancamento' : 'previsao_futura')
                : 'em_andamento';
        const statusOverride = resolver.statusOverride(company.companyId);
        const status = statusOverride || autoStatus;

        // ----- Governança: liberado p/ diretoria? -----
        const released = resolver.isReleased(company.companyId);

        const representativeErp = erpIds.length ? erpIds.slice().sort()[0] : null;

        return {
            header: {
                projectionId: projection.id,
                year: Number(String(endYM).slice(0, 4)),
                upToMonth: endYM,
                startMonth: startYM,
                endMonth: endYM,

                // identidade da empresa (empreendimento)
                companyId: company.companyId,
                companyName: company.companyName,
                enterpriseName: company.companyName,
                erpId: representativeErp,
                displayId: company.companyId != null ? String(company.companyId) : representativeErp,
                costCenterIds,

                // estoque (snapshot CV, empresa)
                totalUnits,
                soldUnits: units.soldUnitsStock,
                soldUnitsStock: units.soldUnitsStock,
                reservedUnits: units.reservedUnits,
                blockedUnits: units.blockedUnits,
                availableUnits: units.availableUnits,
                boletagemUnits,
                blockedConsideredAvailable: blockedConsidered,
                availableInventory,

                // base de orçamento (Fase 1: sem Custo Loja)
                avgTicketGlobal: avgTicket,
                marketingPct: pct,
                custoLoja,                              // referência (não somado ao orçamento na Fase 1)
                unitsTargetTotal: totalUnits,
                projectedUnitsMonth: unitsTargetMonth,
                revenueTargetTotal: totalUnits * avgTicket,
                budgetTotal,
                budgetUpToMonth: budgetTotal,

                // realizado (PARA TRÁS — acumulado até o mês)
                spentTotal,
                spentAccumulated: spentTotal,          // alias explícito p/ a tela nova
                remainingBudgetTotal: saldo,
                pctInvested,
                soldUnitsRealYtd,

                // PARA FRENTE — a comercializar (futuro)
                futureUnits,
                futureUnitsSource,                     // 'projecao' | 'estoque' | 'none'
                futureRevenue,
                recommendedPerFutureUnit,

                // por unidade
                plannedCostPerUnit,
                currentRealCostPerUnit,
                remainingUnitsPlan,
                saldoPerUnit,
                recommendedCostPerUnit: saldoPerUnit,

                // referência / tendência
                avgMonthlySpend,
                monthsElapsed,
                lastMonthSpend: prevMonthSpent,
                trendVsAvg,
                trendVsPrev,
                trendDirection,

                diffTotal: spentTotal - budgetTotal,
                diffPerUnit: currentRealCostPerUnit - plannedCostPerUnit,

                // status / categoria do empreendimento
                status,
                autoStatus,
                statusOverride,
                projectedUnitsFuture,

                // governança
                released,

                monthContext,
            },
            months,
        };
    }

    /* ============================ Lista (por empresa) ============================ */
    async listEnterprisesViability({ year, upToMonth = null, startMonth = null, endMonth = null, aliasId = 'default', onlyReleased = false, companyIds = null }) {
        const { startMonth: startYM, endMonth: endYM } = resolveRange({ year, upToMonth, startMonth, endMonth });
        const ymList = buildYmRange(startYM, endYM);
        const endDate = ymToDateStart(nextYm(endYM));
        const range = { startYM, endYM, ymList, endDate };

        const projection = await this.getActiveProjection();
        const { defaults, linesByKey, fullByKey, futureByKey } = await this.loadProjectionAggregates({
            projectionId: projection.id, aliasId, startYM, endYM,
        });

        if (!defaults.length) {
            return { year: Number(String(endYM).slice(0, 4)), upToMonth: endYM, startMonth: startYM, endMonth: endYM, projectionId: projection.id, count: 0, results: [] };
        }

        // resolve empresa Sienge de cada CC
        const erpIds = defaults.map((d) => d.erp_id).filter(Boolean).map(String);
        const erpToCompany = await this.mapErpsToCompany(erpIds);
        const resolver = await buildSpendingResolver();

        // agrupa defaults por empresa (chave: company_id; sem idCompany → agrupa pelo próprio enterprise_key)
        const groups = new Map();
        for (const d of defaults) {
            const info = d.erp_id ? erpToCompany.get(String(d.erp_id)) : null;
            const companyId = info?.companyId ?? null;
            const groupKey = companyId != null ? `co:${companyId}` : `ek:${d.enterprise_key}`;
            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    companyId,
                    companyName: d.enterprise_name_cache || info?.companyName || (d.erp_id ? `Empresa ${companyId ?? d.erp_id}` : d.enterprise_key),
                    ccRows: [],
                    linesByKey,
                    fullByKey,
                    futureByKey,
                });
            }
            const g = groups.get(groupKey);
            g.ccRows.push(d);
            if (!g.companyName && d.enterprise_name_cache) g.companyName = d.enterprise_name_cache;
        }

        // Filtro server-side por empresa (deep link compartilhável: calcula SÓ as pedidas).
        let companies = [...groups.values()];
        const wanted = Array.isArray(companyIds) && companyIds.length
            ? new Set(companyIds.map(Number).filter(Number.isFinite))
            : null;
        if (wanted) companies = companies.filter((c) => c.companyId != null && wanted.has(Number(c.companyId)));

        // PREFETCH em 1 query por fonte p/ TODAS as empresas (gasto Sienge + contratos).
        // A query do Sienge varre tabelas grandes — rodá-la 1× no lote inteiro é muito
        // mais barato que 1× por empresa. Distribuição por CC/ERP fica em memória.
        const allCcIds = [...new Set(companies.flatMap((c) =>
            c.ccRows.map((r) => Number(r.erp_id)).filter(Number.isFinite)))];
        const allErpIds = [...new Set(companies.flatMap((c) =>
            c.ccRows.map((r) => r.erp_id).filter(Boolean).map(String)))];
        const [spendRows, salesRows] = await Promise.all([
            allCcIds.length ? listMarketingSpendByMonth({ costCenterIds: allCcIds, endDate }) : [],
            this.fetchSalesRows({ erpIds: allErpIds, endDate }),
        ]);
        const spendByCc = new Map();
        for (const r of spendRows) {
            const k = Number(r.costCenterId);
            if (!spendByCc.has(k)) spendByCc.set(k, []);
            spendByCc.get(k).push(r);
        }
        const salesByErp = new Map();
        for (const r of salesRows) {
            const k = String(r.erp);
            if (!salesByErp.has(k)) salesByErp.set(k, []);
            salesByErp.get(k).push(r);
        }
        const prefetch = { spendByCc, salesByErp };

        // Empresas em PARALELO (lotes) — sobrou só a consulta local de unidades por CC.
        const CONCURRENCY = 8;
        const results = [];
        for (let i = 0; i < companies.length; i += CONCURRENCY) {
            const batch = companies.slice(i, i + CONCURRENCY);
            const computed = await Promise.all(batch.map((company) =>
                this.computeCompanyViability({ company, projection, range, resolver, prefetch })
                    .then((viability) => ({ company, viability }))
                    .catch((e) => {
                        console.error(`[DeptSpending] falha ao computar empresa ${company.companyId}:`, e?.message);
                        return null;
                    })
            ));
            for (const item of computed) {
                if (!item) continue;
                const { company, viability } = item;
                const h = viability.header;
                // mostra só se há projeção no mês selecionado OU gasto acompanhado em algum momento
                if (num(h.projectedUnitsMonth) <= 0 && num(h.spentTotal) <= 0) continue;
                // governança: diretoria (onlyReleased) só vê empreendimentos CONFIGURADOS + liberados
                if (onlyReleased && (!h.released || !resolver.isConfigured(company.companyId))) continue;

                results.push({
                    companyId: company.companyId,
                    erpId: h.erpId,
                    displayId: h.displayId,
                    enterpriseName: h.enterpriseName,
                    costCenterIds: h.costCenterIds,
                    released: h.released,
                    header: h,
                    months: viability.months,
                });
            }
        }

        // maior orçamento primeiro
        results.sort((a, b) => num(b.header.budgetTotal) - num(a.header.budgetTotal));

        return {
            year: Number(String(endYM).slice(0, 4)),
            upToMonth: endYM,
            startMonth: startYM,
            endMonth: endYM,
            projectionId: projection.id,
            onlyReleased,
            count: results.length,
            results,
        };
    }

    /* ==================== Relatório Gerencial de Investimento ==================== */

    /* Lines da projeção ativa no EXERCÍCIO (ano do refMonth), por mês, das keys da empresa. */
    async loadYearProjectionLines({ projectionId, aliasId, enterpriseKeys, year }) {
        if (!enterpriseKeys.length) return [];
        return await db.sequelize.query(
            `SELECT year_month, units_target, avg_price_target, marketing_pct
               FROM sales_projection_lines
              WHERE projection_id = :pid AND alias_id = :alias
                AND enterprise_key IN (:keys)
                AND year_month BETWEEN :y01 AND :y12
              ORDER BY year_month ASC`,
            {
                replacements: { pid: projectionId, alias: String(aliasId), keys: enterpriseKeys, y01: `${year}-01`, y12: `${year}-12` },
                type: db.Sequelize.QueryTypes.SELECT,
            }
        );
    }

    /* VGV/unidades projetados APÓS o exercício (saldo p/ os anos seguintes). */
    async loadNextYearsProjection({ projectionId, aliasId, enterpriseKeys, year }) {
        if (!enterpriseKeys.length) return { units: 0, vgv: 0 };
        const [row] = await db.sequelize.query(
            `SELECT COALESCE(SUM(units_target),0) AS units,
                    COALESCE(SUM(units_target * avg_price_target),0) AS vgv
               FROM sales_projection_lines
              WHERE projection_id = :pid AND alias_id = :alias
                AND enterprise_key IN (:keys)
                AND year_month > :y12`,
            {
                replacements: { pid: projectionId, alias: String(aliasId), keys: enterpriseKeys, y12: `${year}-12` },
                type: db.Sequelize.QueryTypes.SELECT,
            }
        );
        return { units: num(row?.units), vgv: num(row?.vgv) };
    }

    /* Gasto ao vivo bucketed (marketing × loja), vida toda até endDate, por mês.
       Loja tem precedência (config explícita por empresa) p/ não contar 2×. */
    async loadBucketSpendByMonth({ costCenterIds, endDate, resolver, companyId }) {
        const mkt = new Map();   // ym -> amount
        const loja = new Map();  // ym -> amount
        const ids = (costCenterIds || []).map(Number).filter((n) => Number.isFinite(n));
        if (!ids.length) return { mkt, loja, mktTotal: 0, lojaTotal: 0 };

        const rows = await listMarketingSpendByMonth({ costCenterIds: ids, endDate });
        let mktTotal = 0;
        let lojaTotal = 0;
        for (const r of rows) {
            const amount = num(r.amount);
            if (resolver.isLoja(r.departmentName, companyId)) {
                loja.set(r.ym, (loja.get(r.ym) || 0) + amount);
                lojaTotal += amount;
            } else if (resolver.isMarketing(r.departmentName, companyId)) {
                mkt.set(r.ym, (mkt.get(r.ym) || 0) + amount);
                mktTotal += amount;
            }
        }
        return { mkt, loja, mktTotal, lojaTotal };
    }

    /**
     * Relatório gerencial de 1 empreendimento (empresa Sienge) no EXERCÍCIO do refMonth.
     * Realizado = Jan..refMonth; Projetado = refMonth+1..Dez (derivado da projeção de
     * vendas: units × price × %mkt). Tetos: Marketing = VGV vida útil × % (motor atual);
     * Loja = Σ custo_loja dos CCs.
     */
    async computeCompanyReport({ companyId, refMonth, aliasId = 'default' }) {
        const endYM = normYM(refMonth);
        const year = String(endYM).slice(0, 4);
        const startYM = `${year}-01`;
        const yearMonths = buildYmRange(startYM, `${year}-12`);
        const monthIndex = Number(String(endYM).slice(5, 7)); // 1..12
        const endDate = ymToDateStart(nextYm(endYM));

        const projection = await this.getActiveProjection();
        const { defaults, linesByKey, fullByKey, futureByKey } = await this.loadProjectionAggregates({
            projectionId: projection.id, aliasId, startYM, endYM,
        });

        const erpToCompany = await this.mapErpsToCompany(defaults.map((d) => d.erp_id).filter(Boolean));
        const resolver = await buildSpendingResolver();

        const cid = Number(companyId);
        const ccRows = defaults.filter((d) => {
            const info = d.erp_id ? erpToCompany.get(String(d.erp_id)) : null;
            return info?.companyId === cid;
        });
        if (!ccRows.length) throw new Error('Empreendimento não encontrado na projeção ativa.');

        const company = {
            companyId: cid,
            companyName: ccRows[0]?.enterprise_name_cache
                || erpToCompany.get(String(ccRows[0]?.erp_id))?.companyName
                || `Empresa ${cid}`,
            ccRows, linesByKey, fullByKey, futureByKey,
        };
        const range = { startYM, endYM, ymList: buildYmRange(startYM, endYM), endDate };

        const enterpriseKeys = ccRows.map((r) => String(r.enterprise_key));
        const costCenterIds = ccRows.map((r) => Number(r.erp_id)).filter((n) => Number.isFinite(n));

        // Cargas independentes em PARALELO: motor (tetos/estoque/status) + projeção do
        // exercício + saldo dos anos seguintes + gasto bucketed (marketing × loja).
        const [viability, yearLines, nextYears, spend] = await Promise.all([
            this.computeCompanyViability({ company, projection, range, resolver }),
            this.loadYearProjectionLines({ projectionId: projection.id, aliasId, enterpriseKeys, year }),
            this.loadNextYearsProjection({ projectionId: projection.id, aliasId, enterpriseKeys, year }),
            this.loadBucketSpendByMonth({ costCenterIds, endDate, resolver, companyId: cid }),
        ]);
        const h = viability.header;
        const pctFallback = num(h.marketingPct);
        const byYm = new Map(); // ym -> { unitsTarget, vgvTarget, mktProjetado }
        for (const ym of yearMonths) byYm.set(ym, { unitsTarget: 0, vgvTarget: 0, mktProjetado: 0 });
        for (const l of yearLines) {
            const ym = String(l.year_month).slice(0, 7);
            const slot = byYm.get(ym);
            if (!slot) continue;
            const u = num(l.units_target);
            const p = num(l.avg_price_target);
            const pct = num(l.marketing_pct) > 0 ? num(l.marketing_pct) : pctFallback;
            slot.unitsTarget += u;
            slot.vgvTarget += u * p;
            slot.mktProjetado += u * p * (pct / 100);
        }
        // ----- Série mensal do exercício (realizado × projetado) -----
        const months = yearMonths.map((ym) => {
            const proj = byYm.get(ym) || { unitsTarget: 0, vgvTarget: 0, mktProjetado: 0 };
            const isRealized = ym <= endYM;
            return {
                ym,
                isRealized,
                unitsTarget: proj.unitsTarget,
                vgvTarget: proj.vgvTarget,
                mktRealizado: isRealized ? (spend.mkt.get(ym) || 0) : 0,
                mktProjetado: !isRealized ? proj.mktProjetado : 0,
                lojaRealizado: isRealized ? (spend.loja.get(ym) || 0) : 0,
                lojaProjetado: 0, // fase de teste: loja sem projeção (ponto de iteração)
            };
        });

        // ----- Agregados do exercício -----
        const mktRealizadoAno = months.reduce((s, m) => s + m.mktRealizado, 0);
        const mktProjetadoAno = months.reduce((s, m) => s + m.mktProjetado, 0);
        const lojaRealizadoAno = months.reduce((s, m) => s + m.lojaRealizado, 0);
        const planoAnoMkt = mktRealizadoAno + mktProjetadoAno;
        const mesesFuturos = 12 - monthIndex;
        const mktProjetadoMes = mesesFuturos > 0 ? mktProjetadoAno / mesesFuturos : 0;

        const yearUnits = months.reduce((s, m) => s + m.unitsTarget, 0);
        const yearVgv = months.reduce((s, m) => s + m.vgvTarget, 0);

        // ----- Governança: consumo da viabilidade aprovada (vida toda + projetado restante) -----
        const ritmoLinear = monthIndex / 12;
        const buildBucket = (key, label, teto, consumido, extra = {}) => {
            const pctConsumido = teto > 0 ? consumido / teto : 0;
            const status = pctConsumido > 1 ? 'acima'
                : pctConsumido > ritmoLinear ? 'atencao' : 'dentro';
            return { key, label, teto, consumido, saldo: teto - consumido, pctConsumido, status, ...extra };
        };
        const tetoMkt = num(h.budgetTotal);          // VGV vida útil × %
        const tetoLoja = num(h.custoLoja);           // Σ custo_loja dos CCs
        const mktConsumido = num(spend.mktTotal) + mktProjetadoAno; // vida toda + projetado do exercício
        const lojaConsumido = num(spend.lojaTotal);
        const buckets = {
            marketing: buildBucket('marketing', 'Marketing', tetoMkt, mktConsumido, {
                realizadoVida: num(spend.mktTotal),
                realizadoAno: mktRealizadoAno,
                projetadoAno: mktProjetadoAno,
                projetadoMes: mktProjetadoMes,
                planoAno: planoAnoMkt,
            }),
            loja: buildBucket('loja', 'Loja física', tetoLoja, lojaConsumido, {
                realizadoVida: num(spend.lojaTotal),
                realizadoAno: lojaRealizadoAno,
                projetadoAno: 0,
                projetadoMes: 0,
                planoAno: lojaRealizadoAno,
            }),
        };
        buckets.total = buildBucket('total', 'Total aprovado',
            tetoMkt + tetoLoja, mktConsumido + lojaConsumido, {
                realizadoVida: num(spend.mktTotal) + num(spend.lojaTotal),
                realizadoAno: mktRealizadoAno + lojaRealizadoAno,
                projetadoAno: mktProjetadoAno,
                projetadoMes: mktProjetadoMes,
                planoAno: planoAnoMkt + lojaRealizadoAno,
            });

        return {
            refMonth: endYM,
            year: Number(year),
            monthIndex,
            company: {
                companyId: cid,
                name: company.companyName,
                erpId: h.erpId,
                costCenterIds: h.costCenterIds,
            },
            // subset do motor: estoque/vendas/status/governança
            viability: {
                totalUnits: h.totalUnits,
                availableUnits: h.availableUnits,
                reservedUnits: h.reservedUnits,
                blockedUnits: h.blockedUnits,
                soldUnitsStock: h.soldUnitsStock,
                boletagemUnits: h.boletagemUnits,
                availableInventory: h.availableInventory,
                soldUnitsRealYtd: h.soldUnitsRealYtd,
                futureUnits: h.futureUnits,
                futureUnitsSource: h.futureUnitsSource,
                avgTicket: h.avgTicketGlobal,
                marketingPct: h.marketingPct,
                vgvTotal: num(h.totalUnits) * num(h.avgTicketGlobal),
                status: h.status,
                released: h.released,
                configured: resolver.isConfigured(cid),
            },
            kpis: {
                vgv: {
                    yearUnits,
                    yearVgv,
                    totalUnits: h.totalUnits,
                    vgvTotal: num(h.totalUnits) * num(h.avgTicketGlobal),
                    nextYearsUnits: nextYears.units,
                    nextYearsVgv: nextYears.vgv,
                    soldUnitsRealYtd: h.soldUnitsRealYtd,
                },
                buckets,
            },
            governance: { ritmoLinear },
            distribution: {
                realizadoAno: mktRealizadoAno,
                aInvestirAno: Math.max(0, planoAnoMkt - mktRealizadoAno),
                pctRealizado: planoAnoMkt > 0 ? mktRealizadoAno / planoAnoMkt : 0,
            },
            months,
        };
    }

    /* ===== Compat: análise de 1 CC → resolve a empresa dele e devolve a da empresa ===== */
    async computeEnterpriseViability({ year, upToMonth = null, startMonth = null, endMonth = null, aliasId = 'default', erpId = null }) {
        const { startMonth: startYM, endMonth: endYM } = resolveRange({ year, upToMonth, startMonth, endMonth });
        const ymList = buildYmRange(startYM, endYM);
        const endDate = ymToDateStart(nextYm(endYM));
        const range = { startYM, endYM, ymList, endDate };

        const projection = await this.getActiveProjection();
        const { defaults, linesByKey, fullByKey, futureByKey } = await this.loadProjectionAggregates({
            projectionId: projection.id, aliasId, startYM, endYM,
        });

        const erpToCompany = await this.mapErpsToCompany([erpId, ...defaults.map((d) => d.erp_id)].filter(Boolean));
        const resolver = await buildSpendingResolver();
        const target = erpId ? erpToCompany.get(String(erpId)) : null;
        const companyId = target?.companyId ?? null;

        const ccRows = defaults.filter((d) => {
            if (companyId != null) {
                const info = d.erp_id ? erpToCompany.get(String(d.erp_id)) : null;
                return info?.companyId === companyId;
            }
            return String(d.erp_id) === String(erpId);
        });

        const company = {
            companyId,
            companyName: target?.companyName || (ccRows[0]?.enterprise_name_cache) || `Empresa ${companyId ?? erpId}`,
            ccRows: ccRows.length ? ccRows : defaults.filter((d) => String(d.erp_id) === String(erpId)),
            linesByKey,
            fullByKey,
            futureByKey,
        };

        return this.computeCompanyViability({ company, projection, range, resolver });
    }
}
