// src/services/viabilityService.js
import db from '../models/sequelize/index.js';
import { summarizeUnitsFromDb } from './cv/enterpriseUnitsSummaryService.js';

const {
    SalesProjection,
    SalesProjectionLine,
    SalesProjectionEnterprise,
    Expense,
    EnterpriseCity,
    Sequelize
} = db;

const { Op } = Sequelize;

/* =========================
   Helpers de período (YM)
========================= */
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
    const yy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${yy}-${mm}`;
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

/**
 * Compatibilidade com front atual:
 * - se vier year + month (upToMonth), usamos start = `${year}-01`, end = upToMonth
 * - se vier start_month/end_month, usa eles.
 */
function resolveRange({ year, upToMonth, startMonth, endMonth }) {
    // prioridade: range explícito
    if (startMonth && endMonth) {
        const start = normYM(startMonth);
        const end = normYM(endMonth);
        if (start > end) throw new Error('start_month não pode ser maior que end_month');
        return { startMonth: start, endMonth: end };
    }

    // fallback: year + upToMonth (igual comportamento atual)
    const y = Number(year);
    if (!y || y < 2000) throw new Error('year inválido');
    const start = `${y}-01`;
    const end = upToMonth ? normYM(upToMonth) : `${y}-12`;
    if (start > end) throw new Error('range inválido para year/month');
    return { startMonth: start, endMonth: end };
}

export default class ViabilityService {
    /* =========================
       Projeção ativa (novo)
    ========================= */
    async getActiveProjection() {
        const proj = await SalesProjection.findOne({
            where: { is_active: true },
            order: [['updated_at', 'DESC']]
        });

        if (!proj) {
            throw new Error('Nenhuma projeção ativa encontrada.');
        }

        return proj;
    }

    /* =========================
       Carrega defaults+lines (novo)
       por (enterprise_key, alias_id)
    ========================= */
    async loadProjectionData({ projectionId, enterpriseKey, aliasId = 'default' }) {
        const projection = await SalesProjection.findByPk(projectionId);
        if (!projection) throw new Error('Projeção não encontrada.');

        const defaults = await SalesProjectionEnterprise.findOne({
            where: {
                projection_id: projectionId,
                enterprise_key: String(enterpriseKey),
                alias_id: String(aliasId)
            },
            order: [['id', 'ASC']]
        });

        const lines = await SalesProjectionLine.findAll({
            where: {
                projection_id: projectionId,
                enterprise_key: String(enterpriseKey),
                alias_id: String(aliasId)
            },
            order: [['year_month', 'ASC']]
        });

        return { projection, defaults, lines };
    }

    async summarizeUnits({ cvEnterpriseId }) {
        if (!cvEnterpriseId) {
            return {
                totalUnits: 0,
                soldUnits: 0,
                soldUnitsStock: 0,
                reservedUnits: 0,
                blockedUnits: 0,
                availableUnits: 0,
                availableInventory: 0
            };
        }
        return summarizeUnitsFromDb(cvEnterpriseId);
    }

    /* =========================
       Despesas por mês (novo)
       usando range start/end
    ========================= */
    async loadExpensesByMonth({ costCenterId, ymList, startDate, endDate }) {
        const result = {};
        ymList.forEach(ym => {
            result[ym] = { month: ym, total: 0, items: [] };
        });

        const rows = await Expense.findAll({
            where: {
                cost_center_id: costCenterId,
                competence_month: { [Op.gte]: startDate, [Op.lt]: endDate }
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

        for (const e of rows) {
            const ym = (e.competence_month instanceof Date)
                ? e.competence_month.toISOString().slice(0, 7)
                : String(e.competence_month).slice(0, 7);

            if (!result[ym]) continue;
            const amount = Number(e.amount || 0);
            result[ym].total += amount;
            result[ym].items.push(e.toJSON ? e.toJSON() : e);
        }

        return result;
    }

    /* =========================
       Vendas por mês (novo)
       usando range start/end
    ========================= */
    async loadSalesByMonth({ erpId, ymList, startDate, endDate }) {
        const result = {};
        ymList.forEach(ym => {
            result[ym] = { month: ym, soldUnits: 0, contracts: [] };
        });

        // sem erpId => sem vendas (manual line)
        if (!erpId) return result;

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
            replacements: { erpId: String(erpId), start: startDate, end: endDate },
            type: db.Sequelize.QueryTypes.SELECT
        });

        for (const r of rows) {
            const ym = r.ym;
            if (!result[ym]) continue;

            let unitsCount = 1;
            if (Array.isArray(r.units)) unitsCount = r.units.length || 1;

            result[ym].soldUnits += unitsCount;
            result[ym].contracts.push(r);
        }

        return result;
    }

    /* =========================
       Resolve CV id (igual)
    ========================= */
    async resolveCvEnterpriseId({ erpId, cvEnterpriseIdFromProjection }) {
        if (cvEnterpriseIdFromProjection != null) {
            const parsed = Number(cvEnterpriseIdFromProjection);
            return parsed;
        }

        if (!erpId) return undefined;

        try {
            const row = await EnterpriseCity.findOne({
                where: { source: 'crm', erp_id: String(erpId) },
                attributes: ['crm_id']
            });

            if (!row) return undefined;
            return row.crm_id != null ? Number(row.crm_id) : undefined;
        } catch (e) {
            console.error('[Viability] resolveCvEnterpriseId: erro', e);
            return undefined;
        }
    }

    /* =========================
       Redistribuição (igual)
    ========================= */
    redistributeBudget({ ymList, plannedBudgetByMonth, expensesByMonth, unitsTargetByMonth, budgetTotal }) {
        let lastIndexWithExpense = -1;
        ymList.forEach((ym, idx) => {
            const spent = expensesByMonth[ym]?.total || 0;
            if (spent > 0) lastIndexWithExpense = idx;
        });

        const adjusted = {};
        ymList.forEach(ym => { adjusted[ym] = plannedBudgetByMonth[ym]; });

        if (lastIndexWithExpense === -1) return adjusted;

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
     * True se existir ao menos 1 lançamento no financeiro para o centro de custo,
     * independente de período.
     *
     * Observações:
     * - aceita costCenterId string/number
     * - não quebra se vier null/undefined
     * - usa consulta leve (SELECT 1 / LIMIT 1)
     */
    async hasAnyExpenseEver(costCenterId) {
        const cc = Number(costCenterId);
        if (!Number.isFinite(cc) || cc <= 0) return false;

        const row = await Expense.findOne({
            where: { cost_center_id: cc },
            attributes: ['id'],
            order: [['id', 'DESC']], // opcional
        });

        return !!row;
    }

    /* =========================
       Coração (novo padrão)
       - calcula para um par (enterprise_key, alias_id)
       - período arbitrário
       - mantém header compatível
    ========================= */
    async computeEnterpriseViability({
        // compat
        year,
        upToMonth = null,

        // novo padrão
        startMonth = null,
        endMonth = null,

        enterpriseKey,
        aliasId = 'default',

        // fontes externas
        erpId = null,
        cvEnterpriseId = undefined,
        costCenterId = null
    }) {
        if (!enterpriseKey) throw new Error('enterpriseKey é obrigatório.');

        const { startMonth: startYM, endMonth: endYM } = resolveRange({
            year,
            upToMonth,
            startMonth,
            endMonth
        });

        const ymList = buildYmRange(startYM, endYM);
        const startDate = ymToDateStart(startYM);
        const endDate = ymToDateStart(nextYm(endYM));

        // header compat: year/upToMonth como antes
        const compatYear = Number(String(endYM).slice(0, 4));
        const compatUpToMonth = endYM;

        const activeProj = await this.getActiveProjection();

        const { projection, defaults, lines } = await this.loadProjectionData({
            projectionId: activeProj.id,
            enterpriseKey,
            aliasId
        });

        const defaultMarketingPctRaw = defaults?.default_marketing_pct;
        const defaultMarketingPct = defaultMarketingPctRaw != null ? Number(defaultMarketingPctRaw) : null;

        // mapa por mês apenas no range
        const byMonth = {};
        const unitsTargetByMonth = {};
        const avgPriceByMonth = {};
        const marketingPctByMonth = {};

        ymList.forEach(ym => {
            byMonth[ym] = { yearMonth: ym, unitsTarget: 0, avgPriceTarget: 0, marketingPct: null };
            unitsTargetByMonth[ym] = 0;
            avgPriceByMonth[ym] = 0;
            marketingPctByMonth[ym] = null;
        });

        // aplica lines (range)
        for (const l of lines) {
            const ym = String(l.year_month).slice(0, 7);
            if (!byMonth[ym]) continue;

            const obj = byMonth[ym];
            obj.unitsTarget = Number(l.units_target || 0);
            obj.avgPriceTarget = Number(l.avg_price_target || 0);

            const rawLinePct = l.marketing_pct;
            const linePct = rawLinePct != null ? Number(rawLinePct) : null;

            let effectivePct = null;
            if (linePct != null && linePct > 0) effectivePct = linePct;
            else if (defaultMarketingPct != null && defaultMarketingPct > 0) effectivePct = defaultMarketingPct;
            else if (linePct != null) effectivePct = linePct; // 0 explícito

            obj.marketingPct = effectivePct;

            byMonth[ym] = obj;
            unitsTargetByMonth[ym] = obj.unitsTarget;
            avgPriceByMonth[ym] = obj.avgPriceTarget;
            marketingPctByMonth[ym] = obj.marketingPct;
        }

        // totais DO PERÍODO (antes era ano inteiro)
        let unitsTargetTotal = 0;
        let revenueTargetTotal = 0;
        let marketingPctChosen = 0;

        ymList.forEach(ym => {
            const obj = byMonth[ym];
            unitsTargetTotal += obj.unitsTarget;
            revenueTargetTotal += obj.unitsTarget * obj.avgPriceTarget;

            if (obj.marketingPct != null && obj.marketingPct > 0 && marketingPctChosen === 0) {
                marketingPctChosen = Number(obj.marketingPct);
            }
        });

        if (marketingPctChosen === 0 && defaultMarketingPct != null && defaultMarketingPct > 0) {
            marketingPctChosen = defaultMarketingPct;
        }

        const avgTicketGlobal = unitsTargetTotal > 0 ? revenueTargetTotal / unitsTargetTotal : 0;

        const pct = marketingPctChosen / 100;
        const budgetTotal = revenueTargetTotal * pct; // agora é "budget do período"

        // compat: "upToMonth" = endYM, então upTo == total do período
        const unitsTargetUpToMonth = unitsTargetTotal;
        const budgetUpToMonth = budgetTotal;

        // CV resolve (preferir defaults.erp_id se não vier erpId)
        const effectiveErpId = (erpId != null && String(erpId).trim() !== '')
            ? String(erpId)
            : (defaults?.erp_id != null ? String(defaults.erp_id) : null);

        const cvIdResolved = await this.resolveCvEnterpriseId({
            erpId: effectiveErpId,
            cvEnterpriseIdFromProjection: cvEnterpriseId
        });

        const unitsSummary = await this.summarizeUnits({ cvEnterpriseId: cvIdResolved });
        const availableInventory = Number(unitsSummary.availableInventory || 0);

        // despesas e vendas no período
        const effectiveCostCenterId =
            costCenterId != null ? Number(costCenterId)
                : (effectiveErpId ? Number(effectiveErpId) : null);

        const expensesByMonth = effectiveCostCenterId
            ? await this.loadExpensesByMonth({ costCenterId: effectiveCostCenterId, ymList, startDate, endDate })
            : (() => {
                const empty = {};
                ymList.forEach(ym => empty[ym] = { month: ym, total: 0, items: [] });
                return empty;
            })();

        const salesByMonth = await this.loadSalesByMonth({
            erpId: effectiveErpId,
            ymList,
            startDate,
            endDate
        });

        const soldUnitsRealYtd = ymList.reduce((acc, ym) => acc + (salesByMonth[ym]?.soldUnits || 0), 0);
        const spentTotal = ymList.reduce((acc, ym) => acc + (expensesByMonth[ym]?.total || 0), 0);

        const remainingBudgetTotalRaw = budgetTotal - spentTotal;
        const remainingBudgetTotal = Math.max(remainingBudgetTotalRaw, 0);

        const plannedCostPerUnit = unitsTargetTotal > 0 ? budgetTotal / unitsTargetTotal : 0;
        const currentRealCostPerUnit = soldUnitsRealYtd > 0 ? spentTotal / soldUnitsRealYtd : 0;

        const remainingUnitsPlan = Math.max(unitsTargetTotal - soldUnitsRealYtd, 0);

        const allowedBudgetSoFar = soldUnitsRealYtd * plannedCostPerUnit;
        const overUnderSoFar = spentTotal - allowedBudgetSoFar;

        const remainingBudgetStandard = remainingUnitsPlan * plannedCostPerUnit;
        const remainingBudgetEffective = remainingBudgetTotal;

        const remainingCostPerUnitEffective =
            remainingUnitsPlan > 0 ? remainingBudgetEffective / remainingUnitsPlan : 0;

        // estoque vs plano (mesma lógica)
        const logicalUnitsForPlan = availableInventory + soldUnitsRealYtd;
        const remainingUnitsVsPlan = logicalUnitsForPlan - unitsTargetTotal;
        const inventoryAfterProjectionUnits = Math.max(remainingUnitsVsPlan, 0);

        const inventoryAfterProjectionRevenue = inventoryAfterProjectionUnits * avgTicketGlobal;
        const inventoryAfterProjectionMarketingBudget = inventoryAfterProjectionRevenue * pct;

        // plano mensal proporcional ao PERÍODO
        const plannedBudgetByMonth = {};
        let plannedSum = 0;

        ymList.forEach(ym => {
            const unitsTarget = unitsTargetByMonth[ym] || 0;
            const planned = unitsTarget * plannedCostPerUnit;
            plannedBudgetByMonth[ym] = planned;
            plannedSum += planned;
        });

        const factor = plannedSum > 0 ? budgetTotal / plannedSum : 1;
        ymList.forEach(ym => {
            plannedBudgetByMonth[ym] = plannedBudgetByMonth[ym] * factor;
        });

        const adjustedBudgetByMonth = this.redistributeBudget({
            ymList,
            plannedBudgetByMonth,
            expensesByMonth,
            unitsTargetByMonth,
            budgetTotal
        });

        // meses detalhados (somente no range)
        const monthsOut = [];
        let cumulativePlanned = 0;
        let cumulativeAdjusted = 0;
        let cumulativeSpent = 0;

        ymList.forEach(ym => {
            const projM = byMonth[ym];
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
                unitsTarget: projM.unitsTarget,
                avgPriceTarget: projM.avgPriceTarget,
                revenueTarget: projM.unitsTarget * projM.avgPriceTarget,
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

        // monthContext = endYM (igual comportamento antigo: mês de competência)
        let monthContext = null;
        {
            const row = monthsOut.find(m => m.yearMonth === endYM);
            if (row) {
                const monthBudget = (row.adjustedBudget ?? row.plannedBudget) || 0;
                monthContext = {
                    yearMonth: endYM,
                    unitsTargetMonth: row.unitsTarget,
                    unitsSoldRealMonth: row.unitsSoldReal,
                    plannedBudgetMonth: row.plannedBudget,
                    adjustedBudgetMonth: row.adjustedBudget,
                    spentMonth: row.spent,
                    remainingBudgetMonth: row.adjustedBudget - row.spent,

                    // aliases pro front
                    monthBudget,
                    monthSpent: row.spent,
                    monthRemaining: monthBudget - row.spent
                };
            }
        }

        return {
            header: {
                // compat
                projectionId: projection.id,
                year: compatYear,
                upToMonth: compatUpToMonth,

                // novo padrão (útil pra evoluir front depois)
                startMonth: startYM,
                endMonth: endYM,
                enterpriseKey,
                aliasId,

                // ids para UI
                erpId: effectiveErpId,
                costCenterId: effectiveCostCenterId ?? null,
                cvEnterpriseId: cvIdResolved ?? null,

                enterpriseName: defaults?.enterprise_name_cache || null,

                // Estoque (snapshot CV)
                totalUnits: unitsSummary.totalUnits,
                soldUnits: unitsSummary.soldUnits,
                soldUnitsStock: unitsSummary.soldUnitsStock ?? unitsSummary.soldUnits ?? 0,
                reservedUnits: unitsSummary.reservedUnits,
                blockedUnits: unitsSummary.blockedUnits,
                availableUnits: unitsSummary.availableUnits,
                availableInventory,

                // "Projeção anual" (agora = período)
                unitsTargetTotal,
                revenueTargetTotal,
                avgTicketGlobal,
                marketingPct: marketingPctChosen,
                budgetTotal,

                // compat antigos (upToMonth = endYM)
                unitsTargetUpToMonth,
                budgetUpToMonth,

                // realizado período
                spentTotal,
                remainingBudgetTotal,
                soldUnitsRealYtd, // mantém nome pra não quebrar

                // viabilidade
                plannedCostPerUnit,
                currentRealCostPerUnit,

                remainingUnitsPlan,
                allowedBudgetSoFar,
                overUnderSoFar,
                remainingBudgetStandard,
                remainingBudgetEffective,
                remainingCostPerUnitEffective,

                diffTotal: spentTotal - budgetTotal,
                diffPerUnit: currentRealCostPerUnit - plannedCostPerUnit,

                inventoryAfterProjectionUnits,
                inventoryAfterProjectionRevenue,
                inventoryAfterProjectionMarketingBudget,

                monthContext
            },
            months: monthsOut
        };
    }

    /* =========================
       Lista (novo padrão)
       - retorna por enterprise_key (não por ERP)
       - mantém erpId para o MultiSelector atual
    ========================= */
    async listEnterprisesViability({
        // compat
        year,
        upToMonth = null,

        // novo
        startMonth = null,
        endMonth = null,

        aliasId = 'default',
    }) {
        const { startMonth: startYM, endMonth: endYM } = resolveRange({
            year,
            upToMonth,
            startMonth,
            endMonth
        });

        const activeProj = await this.getActiveProjection();

        // pega defaults da projeção (novo padrão)
        const enterprises = await SalesProjectionEnterprise.findAll({
            where: { projection_id: activeProj.id, alias_id: String(aliasId) },
            order: [['enterprise_name_cache', 'ASC'], ['enterprise_key', 'ASC']]
        });

        if (!enterprises.length) {
            return {
                year: Number(String(endYM).slice(0, 4)),
                upToMonth: endYM,
                startMonth: startYM,
                endMonth: endYM,
                projectionId: activeProj.id,
                count: 0,
                results: []
            };
        }

        const results = [];

        for (const ent of enterprises) {
            const enterpriseKey = ent.enterprise_key;
            const erpId = ent.erp_id ? String(ent.erp_id) : null;

            const costCenterId =
                ent.cost_center_id != null ? Number(ent.cost_center_id)
                    : (erpId ? Number(erpId) : null);

            // ✅ filtro: só entra se tiver algo lançado no financeiro (qualquer data)
            const hasExpense = await this.hasAnyExpenseEver(costCenterId);
            if (!hasExpense) continue;

            const cvEnterpriseIdResolved = await this.resolveCvEnterpriseId({
                erpId,
                cvEnterpriseIdFromProjection: ent.cv_enterprise_id != null ? Number(ent.cv_enterprise_id) : undefined
            });

            const viability = await this.computeEnterpriseViability({
                year,
                upToMonth,
                startMonth: startYM,
                endMonth: endYM,
                enterpriseKey,
                aliasId,
                erpId,
                cvEnterpriseId: cvEnterpriseIdResolved,
                costCenterId
            });

            const h = viability.header || {};
            const hasProjectionInPeriod = Number(h.unitsTargetTotal || 0) > 0;
            if (!hasProjectionInPeriod) continue;

            const enterpriseName = ent.enterprise_name_cache || h.enterpriseName || enterpriseKey;

            results.push({
                erpId: erpId ? String(erpId) : null,
                displayId: erpId ? String(erpId) : enterpriseKey,
                enterpriseKey,
                cvEnterpriseId: cvEnterpriseIdResolved ?? null,
                costCenterId,
                enterpriseName,
                header: h
            });
        }

        return {
            year: Number(String(endYM).slice(0, 4)),
            upToMonth: endYM,
            startMonth: startYM,
            endMonth: endYM,
            projectionId: activeProj.id,
            count: results.length,
            results
        };
    }
}
