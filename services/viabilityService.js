// src/services/viabilityService.js
import db from '../models/sequelize/index.js';
import { summarizeUnitsFromDb } from './cv/enterpriseUnitsSummaryService.js';

const {
    SalesProjection,
    SalesProjectionLine,
    SalesProjectionEnterprise,
    CvEnterpriseStage,
    CvEnterpriseBlock,
    CvEnterpriseUnit,
    Expense,
    EnterpriseCity,
    Sequelize
} = db;

const { Op } = Sequelize;

/**
 * Gera array ["2025-01", ..., "2025-12"]
 */
function buildYearMonths(year) {
  return Array.from({ length: 12 }, (_, i) =>
    `${year}-${String(i + 1).padStart(2, '0')}`
  );
}

export default class ViabilityService {
    /**
     * Projeção ativa do ano.
     */
    async getActiveProjectionForYear(year) {
        const proj = await SalesProjection.findOne({
            where: {
                year: Number(year),
                is_active: true
            },
            order: [['updated_at', 'DESC']]
        });

        if (!proj) {
            throw new Error(`Nenhuma projeção ativa encontrada para o ano ${year}.`);
        }

        return proj;
    }

    /**
     * Carrega linhas e defaults de projeção para um ERP/Alias.
     */
    async loadProjectionData({ projectionId, erpId }) {
        const projection = await SalesProjection.findByPk(projectionId);
        if (!projection) throw new Error('Projeção não encontrada.');

        // pega TODOS os defaults daquele ERP (todos os módulos)
        const defaultsArray = await SalesProjectionEnterprise.findAll({
            where: {
                projection_id: projectionId,
                erp_id: String(erpId)
            },
            order: [['id', 'ASC']]
        });

        // usa o primeiro como "representante" (nome, % mkt, etc)
        const defaults = defaultsArray[0] || null;

        // pega TODAS as linhas (todos alias)
        const lines = await SalesProjectionLine.findAll({
            where: {
                projection_id: projectionId,
                erp_id: String(erpId)
            },
            order: [['year_month', 'ASC']]
        });

        return { projection, defaults, lines };
    }

    /**
     * Resume unidades do CV (snapshot atual).
     * Busca toda a árvore: etapas -> blocos -> unidades,
     * classifica pelo mapa de disponibilidade e devolve:
     *  - totalUnits
     *  - soldUnits / soldUnitsStock
     *  - reservedUnits
     *  - blockedUnits
     *  - availableUnits
     *  - availableInventory (não vendidas = disp + reserv + bloqueadas)
     */
    async summarizeUnits({ cvEnterpriseId }) {
        return summarizeUnitsFromDb(cvEnterpriseId);
    }

    /**
     * Despesas de marketing por mês no ano.
     */
    async loadExpensesByMonth({ costCenterId, year }) {
        console.log('[Viability] loadExpensesByMonth: IN', { costCenterId, year });

        const months = buildYearMonths(year);
        const result = {};
        for (const ym of months) {
            result[ym] = {
                month: ym,
                total: 0,
                items: []
            };
        }

        const start = `${year}-01-01`;
        const end = `${year + 1}-01-01`;

        console.log('[Viability] loadExpensesByMonth: filtro', { start, end });

        const rows = await Expense.findAll({
            where: {
                cost_center_id: costCenterId,
                competence_month: {
                    [Op.gte]: start,
                    [Op.lt]: end
                }
            },
            attributes: [
                'id',
                'competence_month',
                'amount',
                'description',
                'department_id',
                'department_name',
                'department_category_id',
                'department_category_name'
            ]
        });

        console.log('[Viability] loadExpensesByMonth: rows', {
            count: rows.length,
            first5: rows.slice(0, 5).map(r => (r.toJSON ? r.toJSON() : r))
        });

        for (const e of rows) {
            let ym;
            if (e.competence_month instanceof Date) {
                ym = e.competence_month.toISOString().slice(0, 7);
            } else {
                ym = String(e.competence_month).slice(0, 7);
            }

            if (!result[ym]) continue;

            const amount = Number(e.amount || 0);
            result[ym].total += amount;
            result[ym].items.push(e.toJSON ? e.toJSON() : e);
        }

        console.log('[Viability] loadExpensesByMonth: OUT', {
            costCenterId,
            year,
            months: months.map(ym => ({ ym, total: result[ym].total }))
        });

        return result;
    }

    /**
     * Vendas reais por mês para um ERP no ano.
     */
    async loadSalesByMonth({ erpId, year }) {
        console.log('[Viability] loadSalesByMonth: IN', { erpId, year });

        const months = buildYearMonths(year);
        const result = {};
        for (const ym of months) {
            result[ym] = {
                month: ym,
                soldUnits: 0,
                contracts: []
            };
        }

        const start = `${year}-01-01`;
        const end = `${year + 1}-01-01`;

        console.log('[Viability] loadSalesByMonth: intervalo', { start, end });

        const sql = `
      SELECT
        c.id,
        c.enterprise_id,
        c.enterprise_name,
        c.situation,
        c.financial_institution_date::date AS fid,
        to_char(c.financial_institution_date, 'YYYY-MM') AS ym,
        c.units
      FROM contracts c
      WHERE
        c.enterprise_id::text = :erpId
        AND c.financial_institution_date >= :start
        AND c.financial_institution_date < :end
        AND c.situation IN ('Emitido', 'Autorizado')
    `;

        const rows = await db.sequelize.query(sql, {
            replacements: { erpId: String(erpId), start, end },
            type: db.Sequelize.QueryTypes.SELECT
        });

        console.log('[Viability] loadSalesByMonth: contratos', {
            erpId,
            count: rows.length,
            first5: rows.slice(0, 5)
        });

        for (const r of rows) {
            const ym = r.ym;
            if (!result[ym]) continue;

            let unitsCount = 1;
            if (Array.isArray(r.units)) {
                unitsCount = r.units.length || 1;
            }

            result[ym].soldUnits += unitsCount;
            result[ym].contracts.push(r);
        }

        console.log('[Viability] loadSalesByMonth: OUT', {
            erpId,
            year,
            months: months.map(ym => ({
                ym,
                soldUnits: result[ym].soldUnits
            }))
        });

        return result;
    }

    /**
     * Resolve idempreendimento do CV via vínculo ERP/CRM.
     */
    async resolveCvEnterpriseId({ erpId, cvEnterpriseIdFromProjection }) {
        console.log('[Viability] resolveCvEnterpriseId: IN', {
            erpId,
            cvEnterpriseIdFromProjection
        });

        if (cvEnterpriseIdFromProjection != null) {
            const parsed = Number(cvEnterpriseIdFromProjection);
            console.log('[Viability] resolveCvEnterpriseId: usando id da projeção', {
                cvEnterpriseId: parsed
            });
            return parsed;
        }

        if (!erpId) {
            console.log('[Viability] resolveCvEnterpriseId: sem erpId');
            return undefined;
        }

        try {
            const row = await EnterpriseCity.findOne({
                where: {
                    source: 'crm',
                    erp_id: String(erpId)
                },
                attributes: [
                    'id',
                    'crm_id',
                    'erp_id',
                    'enterprise_name',
                    'default_city',
                    'city_override'
                ]
            });

            if (!row) {
                console.log('[Viability] resolveCvEnterpriseId: nenhum vínculo', { erpId });
                return undefined;
            }

            const rawCrmId = row.crm_id;
            const cvId = rawCrmId != null ? Number(rawCrmId) : undefined;

            console.log('[Viability] resolveCvEnterpriseId: vínculo encontrado', {
                erpId,
                rowId: row.id,
                crm_id: rawCrmId,
                enterprise_name: row.enterprise_name,
                default_city: row.default_city,
                city_override: row.city_override,
                cvId
            });

            return cvId;
        } catch (e) {
            console.error('[Viability] resolveCvEnterpriseId: erro', e);
            return undefined;
        }
    }

    /**
     * Redistribui orçamento de marketing para meses futuros.
     */
    redistributeBudget({ ymList, plannedBudgetByMonth, expensesByMonth, unitsTargetByMonth, budgetTotal }) {
        let lastIndexWithExpense = -1;
        ymList.forEach((ym, idx) => {
            const spent = expensesByMonth[ym]?.total || 0;
            if (spent > 0) lastIndexWithExpense = idx;
        });

        const adjusted = {};
        ymList.forEach(ym => { adjusted[ym] = plannedBudgetByMonth[ym]; });

        if (lastIndexWithExpense === -1) {
            // ninguém gastou ainda → plano original
            return adjusted;
        }

        let spentSoFar = 0;
        for (let i = 0; i <= lastIndexWithExpense; i++) {
            const ym = ymList[i];
            spentSoFar += expensesByMonth[ym]?.total || 0;
        }

        const remainingBudget = Math.max(budgetTotal - spentSoFar, 0);

        let remainingUnitsTarget = 0;
        for (let i = lastIndexWithExpense + 1; i < ymList.length; i++) {
            const ym = ymList[i];
            remainingUnitsTarget += unitsTargetByMonth[ym] || 0;
        }

        if (remainingUnitsTarget <= 0) {
            for (let i = lastIndexWithExpense + 1; i < ymList.length; i++) {
                const ym = ymList[i];
                adjusted[ym] = 0;
            }
            return adjusted;
        }

        const adjustedCostPerUnit = remainingBudget / remainingUnitsTarget;

        for (let i = lastIndexWithExpense + 1; i < ymList.length; i++) {
            const ym = ymList[i];
            const unitsTarget = unitsTargetByMonth[ym] || 0;
            adjusted[ym] = unitsTarget * adjustedCostPerUnit;
        }

        return adjusted;
    }

    /**
     * Coração da regra.
     */
    async computeEnterpriseViability({
        year,
        erpId,
        aliasId,
        cvEnterpriseId,
        costCenterId,
        upToMonth = null
    }) {
        console.log('[Viability] computeEnterpriseViability: IN', {
            year,
            erpId,
            aliasId,
            cvEnterpriseId,
            costCenterId,
            upToMonth
        });

        const ymFullList = buildYearMonths(year);
        const ymCutList = upToMonth
            ? ymFullList.filter(ym => ym <= upToMonth)
            : ymFullList;

        // 1) Projeção ativa
        const activeProj = await this.getActiveProjectionForYear(year);
        console.log('[Viability] computeEnterpriseViability: activeProj', {
            id: activeProj.id,
            year: activeProj.year
        });

        const { projection, defaults, lines } = await this.loadProjectionData({
            projectionId: activeProj.id,
            erpId
        });

        console.log('[Viability] computeEnterpriseViability: projection data', {
            projectionId: projection.id,
            defaults: defaults
                ? {
                    id: defaults.id,
                    erp_id: defaults.erp_id,
                    alias_id: defaults.alias_id,
                    default_marketing_pct: defaults.default_marketing_pct,
                    enterprise_name_cache: defaults.enterprise_name_cache
                }
                : null,
            linesCount: lines.length,
            first5Lines: lines.slice(0, 5).map(l => (l.toJSON ? l.toJSON() : l))
        });

        const byMonth = {};
        const unitsTargetByMonth = {};
        const avgPriceByMonth = {};
        const marketingPctByMonth = {};

        ymFullList.forEach(ym => {
            byMonth[ym] = {
                yearMonth: ym,
                unitsTarget: 0,
                avgPriceTarget: 0,
                marketingPct: null
            };
            unitsTargetByMonth[ym] = 0;
            avgPriceByMonth[ym] = 0;
            marketingPctByMonth[ym] = null;
        });

        const defaultMarketingPctRaw = defaults?.default_marketing_pct;
        const defaultMarketingPct =
            defaultMarketingPctRaw != null ? Number(defaultMarketingPctRaw) : null;

        // 2) Targets + % marketing efetivo por mês
        for (const l of lines) {
            const ym = String(l.year_month).slice(0, 7);
            if (!byMonth[ym]) continue;

            const obj = byMonth[ym];

            obj.unitsTarget = Number(l.units_target || 0);
            obj.avgPriceTarget = Number(l.avg_price_target || 0);

            const rawLinePct = l.marketing_pct;
            const linePct = rawLinePct != null ? Number(rawLinePct) : null;

            let effectivePct = null;
            if (linePct != null && linePct > 0) {
                effectivePct = linePct;
            } else if (defaultMarketingPct != null && defaultMarketingPct > 0) {
                effectivePct = defaultMarketingPct;
            } else if (linePct != null) {
                effectivePct = linePct; // 0 explícito
            }

            obj.marketingPct = effectivePct;

            byMonth[ym] = obj;
            unitsTargetByMonth[ym] = obj.unitsTarget;
            avgPriceByMonth[ym] = obj.avgPriceTarget;
            marketingPctByMonth[ym] = obj.marketingPct;
        }

        console.log('[Viability] computeEnterpriseViability: byMonth', {
            months: ymFullList.map(ym => ({
                ym,
                unitsTarget: byMonth[ym].unitsTarget,
                avgPriceTarget: byMonth[ym].avgPriceTarget,
                marketingPct: byMonth[ym].marketingPct
            }))
        });

        // 3) Totais de projeção (ANO INTEIRO)
        let unitsTargetTotal = 0;
        let revenueTargetTotal = 0;
        let marketingPctChosen = 0;

        ymFullList.forEach(ym => {
            const obj = byMonth[ym];
            unitsTargetTotal += obj.unitsTarget;
            revenueTargetTotal += obj.unitsTarget * obj.avgPriceTarget;

            if (obj.marketingPct != null && obj.marketingPct > 0 && marketingPctChosen === 0) {
                marketingPctChosen = Number(obj.marketingPct);
            }
        });

        if (marketingPctChosen === 0 && defaultMarketingPct != null && defaultMarketingPct > 0) {
            marketingPctChosen = defaultMarketingPct;
            console.log('[Viability] computeEnterpriseViability: usando defaultMarketingPct', {
                defaultMarketingPct,
                marketingPctChosen
            });
        }

        const avgTicketGlobal =
            unitsTargetTotal > 0 ? revenueTargetTotal / unitsTargetTotal : 0;

        const pct = marketingPctChosen / 100;
        const budgetTotal = revenueTargetTotal * pct; // orçamento ANUAL

        // Projeção só até o mês de competência (upToMonth)
        let unitsTargetUpToMonth = 0;
        let revenueTargetUpToMonth = 0;

        if (upToMonth) {
            ymCutList.forEach(ym => {
                const obj = byMonth[ym];
                unitsTargetUpToMonth += obj.unitsTarget;
                revenueTargetUpToMonth += obj.unitsTarget * obj.avgPriceTarget;
            });
        }

        const budgetUpToMonth = revenueTargetUpToMonth * pct;

        console.log('[Viability] computeEnterpriseViability: projeção ano', {
            unitsTargetTotal,
            revenueTargetTotal,
            marketingPctChosen,
            avgTicketGlobal,
            budgetTotal
        });

        // 4) Resolver cvEnterpriseId
        const cvIdResolved = await this.resolveCvEnterpriseId({
            erpId,
            cvEnterpriseIdFromProjection: cvEnterpriseId
        });

        console.log('[Viability] computeEnterpriseViability: cvEnterpriseId resolvido', {
            erpId,
            rawCvEnterpriseId: cvEnterpriseId,
            cvIdResolved
        });

        // 5) Estoque (snapshot)
        const unitsSummary = await this.summarizeUnits({
            cvEnterpriseId: cvIdResolved
        });

        console.log('[Viability] computeEnterpriseViability: unitsSummary', unitsSummary);

        const availableInventory = unitsSummary.availableInventory;

        // 6) Despesas reais (ano todo)
        const expensesByMonth = await this.loadExpensesByMonth({
            costCenterId,
            year
        });

        // 7) Vendas reais (ano todo)
        const salesByMonth = await this.loadSalesByMonth({
            erpId,
            year
        });

        // YTD (até upToMonth)
        const soldUnitsRealYtd = ymCutList.reduce(
            (acc, ym) => acc + (salesByMonth[ym]?.soldUnits || 0),
            0
        );

        const spentTotal = ymCutList.reduce(
            (acc, ym) => acc + (expensesByMonth[ym]?.total || 0),
            0
        );

        const remainingBudgetTotalRaw = budgetTotal - spentTotal;
        const remainingBudgetTotal = Math.max(remainingBudgetTotalRaw, 0);

        const plannedCostPerUnit =
            unitsTargetTotal > 0 ? budgetTotal / unitsTargetTotal : 0;

        const currentRealCostPerUnit =
            soldUnitsRealYtd > 0 ? spentTotal / soldUnitsRealYtd : 0;

        // Unidades restantes do plano anual
        const remainingUnitsPlan = Math.max(unitsTargetTotal - soldUnitsRealYtd, 0);

        // Quanto "poderíamos" ter gasto até agora seguindo a viabilidade planejada
        const allowedBudgetSoFar = soldUnitsRealYtd * plannedCostPerUnit;

        // Diferença entre o que gastamos e esse permitido
        const overUnderSoFar = spentTotal - allowedBudgetSoFar;
        // > 0 => gastou mais do que deveria
        // < 0 => gastou menos (tem "crédito")

        // Orçamento restante padrão (ignorando histórico)
        const remainingBudgetStandard = remainingUnitsPlan * plannedCostPerUnit;

        // Orçamento restante REAL (considerando o histórico de gastos)
        const remainingBudgetEffective = remainingBudgetTotal;

        // Viabilidade por unidade PARA AS UNIDADES RESTANTES
        const remainingCostPerUnitEffective =
            remainingUnitsPlan > 0 ? remainingBudgetEffective / remainingUnitsPlan : 0;

        console.log('[Viability] computeEnterpriseViability: gastos x vendas', {
            spentTotal,
            soldUnitsRealYtd,
            remainingBudgetTotal,
            plannedCostPerUnit,
            currentRealCostPerUnit,
            remainingUnitsPlan,
            allowedBudgetSoFar,
            overUnderSoFar,
            remainingBudgetStandard,
            remainingBudgetEffective,
            remainingCostPerUnitEffective
        });

        // 7.1) Estoque x Projeção (considerando vendas já realizadas + estoque atual)
        const logicalUnitsForPlan = availableInventory + soldUnitsRealYtd;

        // Quantas unidades eu tenho (vendidas + estoque) em relação ao plano anual
        const remainingUnitsVsPlan = logicalUnitsForPlan - unitsTargetTotal;

        // Se for >= 0, tenho unidades sobrando para cumprir a projeção
        // Se for < 0, faltam unidades
        const inventoryAfterProjectionUnits = Math.max(remainingUnitsVsPlan, 0);
        // const inventoryShortfallUnits =
        //     remainingUnitsVsPlan < 0 ? Math.abs(remainingUnitsVsPlan) : 0;

        // Converte "unidades que sobram" em receita e orçamento de marketing
        const inventoryAfterProjectionRevenue =
            inventoryAfterProjectionUnits * avgTicketGlobal;

        const inventoryAfterProjectionMarketingBudget =
            inventoryAfterProjectionRevenue * pct;

        console.log('[Viability] computeEnterpriseViability: estoque vs projeção (corrigido)', {
            availableInventory,
            soldUnitsRealYtd,
            unitsTargetTotal,
            logicalUnitsForPlan,
            remainingUnitsVsPlan,
            inventoryAfterProjectionUnits,
            // inventoryShortfallUnits,
            inventoryAfterProjectionRevenue,
            inventoryAfterProjectionMarketingBudget
        });

        // 8) Plano mensal (proporcional no ANO)
        const plannedBudgetByMonth = {};
        let plannedSum = 0;

        ymFullList.forEach(ym => {
            const unitsTarget = unitsTargetByMonth[ym] || 0;
            const planned = unitsTarget * plannedCostPerUnit;
            plannedBudgetByMonth[ym] = planned;
            plannedSum += planned;
        });

        const factor = plannedSum > 0 ? budgetTotal / plannedSum : 1;
        ymFullList.forEach(ym => {
            plannedBudgetByMonth[ym] = plannedBudgetByMonth[ym] * factor;
        });

        console.log('[Viability] computeEnterpriseViability: plannedBudgetByMonth', {
            months: ymFullList.map(ym => ({
                ym,
                planned: plannedBudgetByMonth[ym]
            }))
        });

        // 9) Redistribuição ANUAL
        const adjustedBudgetByMonth = this.redistributeBudget({
            ymList: ymFullList,
            plannedBudgetByMonth,
            expensesByMonth,
            unitsTargetByMonth,
            budgetTotal
        });

        console.log('[Viability] computeEnterpriseViability: adjustedBudgetByMonth', {
            months: ymFullList.map(ym => ({
                ym,
                adjusted: adjustedBudgetByMonth[ym],
                spent: expensesByMonth[ym]?.total || 0
            }))
        });

        // 10) Meses detalhados (ANO TODO)
        const monthsOut = [];
        let cumulativePlanned = 0;
        let cumulativeAdjusted = 0;
        let cumulativeSpent = 0;

        ymFullList.forEach(ym => {
            const proj = byMonth[ym];
            const exp = expensesByMonth[ym] || { total: 0, items: [] };
            const sales = salesByMonth[ym] || { soldUnits: 0, contracts: [] };

            const planned = plannedBudgetByMonth[ym];
            const adjusted = adjustedBudgetByMonth[ym];
            const spent = exp.total;

            cumulativePlanned += planned;
            cumulativeAdjusted += adjusted;
            cumulativeSpent += spent;

            const diff = spent - adjusted;
            let status = 'ON_TRACK';
            if (diff > 0) status = 'OVER';
            if (diff < 0) status = 'UNDER';

            monthsOut.push({
                yearMonth: ym,
                unitsTarget: proj.unitsTarget,
                avgPriceTarget: proj.avgPriceTarget,
                revenueTarget: proj.unitsTarget * proj.avgPriceTarget,
                unitsSoldReal: sales.soldUnits,
                plannedBudget: planned,
                adjustedBudget: adjusted,
                spent,
                diff,
                status,
                cumulativePlanned,
                cumulativeAdjusted,
                cumulativeSpent,
                raw: {
                    expenses: exp.items,
                    contracts: sales.contracts
                }
            });
        });

        // 11) Contexto do mês
        let monthContext = null;
        if (upToMonth) {
            const row = monthsOut.find(m => m.yearMonth === upToMonth);
            if (row) {
                const monthBudget = (row.adjustedBudget ?? row.plannedBudget) || 0;
                monthContext = {
                    yearMonth: upToMonth,
                    unitsTargetMonth: row.unitsTarget,
                    unitsSoldRealMonth: row.unitsSoldReal,
                    plannedBudgetMonth: row.plannedBudget,
                    adjustedBudgetMonth: row.adjustedBudget,
                    spentMonth: row.spent,
                    remainingBudgetMonth: row.adjustedBudget - row.spent,

                    // aliases usados pelo front (sem quebrar nada existente)
                    monthBudget,
                    monthSpent: row.spent,
                    monthRemaining: monthBudget - row.spent
                };
            }
        }

        console.log('[Viability] computeEnterpriseViability: OUT header resumo', {
            erpId,
            aliasId,
            year,
            upToMonth,
            unitsTargetTotal,
            revenueTargetTotal,
            budgetTotal,
            spentTotal,
            availableInventory,
            // inventoryShortfallUnits
        });

        return {
            header: {
                projectionId: projection.id,
                erpId,
                year,
                upToMonth,

                enterpriseName: defaults?.enterprise_name_cache || null,

                // Estoque (snapshot CV)
                totalUnits: unitsSummary.totalUnits,
                soldUnits: unitsSummary.soldUnits,
                soldUnitsStock: unitsSummary.soldUnitsStock ?? unitsSummary.soldUnits ?? 0,
                reservedUnits: unitsSummary.reservedUnits,
                blockedUnits: unitsSummary.blockedUnits,
                availableUnits: unitsSummary.availableUnits,
                availableInventory,

                // Projeção anual
                unitsTargetTotal,
                revenueTargetTotal,
                avgTicketGlobal,
                marketingPct: marketingPctChosen,
                budgetTotal,

                // Projeção até o mês de competência
                unitsTargetUpToMonth,
                budgetUpToMonth,

                // Realizado até o mês de competência
                spentTotal,
                remainingBudgetTotal,
                soldUnitsRealYtd,

                // Viabilidade por unidade (planejada x real)
                plannedCostPerUnit,
                currentRealCostPerUnit,

                // Regra de viabilidade "carregando" saldo entre unidades
                remainingUnitsPlan,
                allowedBudgetSoFar,
                overUnderSoFar,
                remainingBudgetStandard,
                remainingBudgetEffective,
                remainingCostPerUnitEffective,

                // Diferenças globais vs budget anual
                diffTotal: spentTotal - budgetTotal,
                diffPerUnit: currentRealCostPerUnit - plannedCostPerUnit,

                // Estoque x projeção (pós-projeção)
                inventoryAfterProjectionUnits,
                // inventoryShortfallUnits,
                inventoryAfterProjectionRevenue,
                inventoryAfterProjectionMarketingBudget,

                // Contexto mensal
                monthContext
            },
            months: monthsOut
        };
    }

    /**
     * Lista viabilidade por empreendimento (header).
     */
    async listEnterprisesViability({ year, upToMonth = null }) {
        console.log('[Viability] listEnterprisesViability: IN', { year, upToMonth });

        const activeProj = await this.getActiveProjectionForYear(year);

        // pega TODOS os processos (todos alias) da projeção
        const enterprises = await SalesProjectionEnterprise.findAll({
            where: {
                projection_id: activeProj.id
            },
            order: [
                ['enterprise_name_cache', 'ASC'],
                ['erp_id', 'ASC']
            ]
        });

        if (!enterprises.length) {
            return {
                year,
                upToMonth,
                projectionId: activeProj.id,
                count: 0,
                results: []
            };
        }

        // agrupa por ERP
        const byErp = new Map(); // erpId -> [ent1, ent2, ...]
        for (const ent of enterprises) {
            const erpId = String(ent.erp_id);
            if (!byErp.has(erpId)) byErp.set(erpId, []);
            byErp.get(erpId).push(ent);
        }

        const results = [];

        for (const [erpId, group] of byErp.entries()) {
            const first = group[0];

            const cvEnterpriseIdFromProjection =
                first.cv_enterprise_id != null ? Number(first.cv_enterprise_id) : undefined;

            const cvEnterpriseIdResolved = await this.resolveCvEnterpriseId({
                erpId,
                cvEnterpriseIdFromProjection
            });

            const costCenterId =
                first.cost_center_id != null
                    ? Number(first.cost_center_id)
                    : Number(first.erp_id);

            const viability = await this.computeEnterpriseViability({
                year,
                erpId,
                cvEnterpriseId: cvEnterpriseIdResolved,
                costCenterId,
                upToMonth
            });

            const h = viability.header || {};

            // 🔴 Regra: só entra se houver projeção de vendas no período
            const hasProjectionInPeriod =
                Number(h.unitsTargetUpToMonth || 0) > 0 ||
                Number(h.unitsTargetTotal || 0) > 0;

            if (!hasProjectionInPeriod) {
                continue;
            }

            // Nome agregado: se tiver mais de um módulo, deixa claro
            let enterpriseName = first.enterprise_name_cache || h.enterpriseName || erpId;
            if (group.length > 1) {
                enterpriseName = `${enterpriseName} (+${group.length - 1} módulos)`;
            }

            results.push({
                erpId,
                cvEnterpriseId: cvEnterpriseIdResolved ?? null,
                costCenterId,
                enterpriseName,
                header: h
            });
        }

        return {
            year,
            upToMonth,
            projectionId: activeProj.id,
            count: results.length,
            results
        };
    }
}
