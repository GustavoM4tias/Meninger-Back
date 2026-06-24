// src/services/viabilityService.js
//
// Motor de cálculo da Viabilidade de Marketing (company-level).
//
// Unidade de análise = EMPRESA Sienge (= empreendimento). Vários centros de custo
// (CCs) podem pertencer à mesma empresa (ex.: empresa 99 → CCs 99901, 99903). O
// agrupamento usa enterprise_cities.raw_payload.idCompany (mesma fonte do Bills
// Auto-Sync). Ver memória [[project_viability]].
//
// Regras (definidas com o usuário):
//  - Orçamento "vida útil": B = totalUnits × ticketMédio × %marketing + Σ custoLoja.
//    Custo Loja entra no pool (não é consumido primeiro).
//  - Custo planejado/unidade = B / totalUnits.
//  - Gasto = despesas dos CCs da empresa, SOMENTE departamentos de marketing
//    (config admin global + exceções por empresa), SEM canceladas, competência ≤ mês.
//  - Saldo = B − gasto; saldo/unidade a vender = saldo / inventárioMarketing.
//  - Recomendado do mês = saldo/unidade × meta de unidades do mês.
//  - Unidades: reservada conta como disponível; bloqueada NÃO conta por padrão
//    (admin libera N por empresa); vendida sai do estoque a vender.

import db from '../models/sequelize/index.js';
import { resolveUnitsForErp } from './cv/enterpriseUnitsSummaryService.js';
import { buildMarketingResolver } from './viability/viabilityConfigService.js';
import { listMarketingSpendByMonth } from './sienge/payableLiveService.js';

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

export default class ViabilityService {
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
        // sem mapa de unidades no CV (ex.: Ingá, Anjos).
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
            console.error('[Viability] resolveCvEnterpriseId erro', e);
            return undefined;
        }
    }

    /* Soma o snapshot de unidades dos CCs da empresa usando a COLETA UNIFICADA do serviço
       de CV (resolveUnitsForErp) — exatamente a MESMA da tela de Projeção. Dedupe por erp_id;
       master-only + módulos não se sobrepõem, então a soma é segura. */
    async summarizeCompanyUnits(erpIds) {
        const acc = {
            totalUnits: 0, soldUnitsStock: 0, reservedUnits: 0,
            blockedUnits: 0, availableUnits: 0,
        };
        const seen = new Set();
        for (const erp of (erpIds || [])) {
            const key = String(erp);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const s = await resolveUnitsForErp(key);
            if (!s) continue;
            acc.totalUnits += num(s.totalUnits);
            acc.soldUnitsStock += num(s.soldUnitsStock ?? s.soldUnits);
            acc.reservedUnits += num(s.reservedUnits);
            acc.blockedUnits += num(s.blockedUnits);
            acc.availableUnits += num(s.availableUnits);
        }
        return acc;
    }

    /* Despesas de marketing dos CCs, vida toda até endDate, por mês. Exclui canceladas
       e filtra por departamento de marketing (resolver). */
    async loadExpensesLifetimeByMonth({ costCenterIds, endDate, resolver, companyId }) {
        const byMonth = new Map();
        const ids = (costCenterIds || []).map(Number).filter((n) => Number.isFinite(n));
        if (!ids.length) return { byMonth, total: 0, firstYm: null };

        // Lê AO VIVO do backup do Sienge (agregado por mês de competência + departamento).
        // competência = mês do vencimento, < endDate (mesma semântica do antigo competence_month).
        const rows = await listMarketingSpendByMonth({ costCenterIds: ids, endDate });

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

    /* Vendas (unidades) realizadas dos CCs até endDate, por mês. */
    async loadSalesLifetimeByMonth({ erpIds, endDate }) {
        const byMonth = new Map();
        const ids = [...new Set((erpIds || []).map((e) => String(e)).filter(Boolean))];
        if (!ids.length) return { byMonth, total: 0 };

        const rows = await db.sequelize.query(
            `SELECT to_char(c.financial_institution_date, 'YYYY-MM') AS ym, c.units
               FROM contracts c
              WHERE c.enterprise_id::text IN (:ids)
                AND c.financial_institution_date < :end
                AND c.situation IN ('Emitido','Autorizado')`,
            { replacements: { ids, end: endDate }, type: db.Sequelize.QueryTypes.SELECT }
        );

        let total = 0;
        for (const r of rows) {
            const units = Array.isArray(r.units) ? (r.units.length || 1) : 1;
            byMonth.set(r.ym, (byMonth.get(r.ym) || 0) + units);
            total += units;
        }
        return { byMonth, total };
    }

    /* ============================ Núcleo: 1 empresa ============================ */
    async computeCompanyViability({ company, projection, range, resolver }) {
        const { startYM, endYM, ymList, endDate } = range;
        const ccRows = company.ccRows; // defaults da projeção dos CCs da empresa
        const erpIds = ccRows.map((r) => r.erp_id).filter(Boolean).map(String);
        const costCenterIds = erpIds.map(Number).filter((n) => Number.isFinite(n));

        // ----- Projeção agregada (ticket, %, meta mensal, loja, total manual) -----
        let unitsTargetTotal = 0;       // soma das metas de unidade no período (p/ ticket ponderado)
        let revenueTarget = 0;          // soma units×price no período
        const unitsTargetByMonth = {};
        ymList.forEach((ym) => { unitsTargetByMonth[ym] = 0; });

        let pct = 0;
        let projectionTotalUnits = 0;
        let custoLoja = 0;
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

        // ----- Unidades do CV (mesma resolução da tela de Projeção) + config de bloqueadas -----
        const units = await this.summarizeCompanyUnits(erpIds);

        // "bloqueadas consideradas disponíveis" agora vem da PROJEÇÃO (por CC, somado).
        const blockedConsidered = Math.min(blockedConsideredRaw, units.blockedUnits);

        // ----- Base de orçamento (vida útil) -----
        // total de unidades: total manual da projeção > snapshot do CV > soma da projeção
        const totalUnits = projectionTotalUnits > 0 ? projectionTotalUnits
            : units.totalUnits > 0 ? units.totalUnits
                : projectionFullUnits;
        const budgetTotal = totalUnits * avgTicket * (pct / 100) + custoLoja;
        const plannedCostPerUnit = totalUnits > 0 ? budgetTotal / totalUnits : 0;

        // ----- Gasto de marketing (vida toda até o mês) -----
        const { byMonth: spentByMonth, total: spentTotal, firstYm: firstSpendYm } =
            await this.loadExpensesLifetimeByMonth({ costCenterIds, endDate, resolver, companyId: company.companyId });

        // ----- Vendas realizadas (vida toda até o mês) -----
        const { byMonth: soldByMonth, total: soldUnitsRealYtd } =
            await this.loadSalesLifetimeByMonth({ erpIds, endDate });

        // ----- Estoque disponível p/ marketing -----
        // Com mapa no CV: disponíveis + reservadas + bloqueadas liberadas (mesmo que dê 0 =
        // tudo vendido, como mostra a tela de Projeção). SEM mapa no CV: cai para a projeção
        // (planejado − vendido). Reservada sempre conta; bloqueada só a parcela liberada.
        const cvAvailable = units.availableUnits + units.reservedUnits + blockedConsidered;
        const projectionRemaining = Math.max(0, projectionFullUnits - soldUnitsRealYtd);
        const availableInventory = units.totalUnits > 0 ? cvAvailable : projectionRemaining;

        // ----- Derivados -----
        const saldo = budgetTotal - spentTotal;                 // pode ser negativo (estourou)
        const pctInvested = budgetTotal > 0 ? spentTotal / budgetTotal : 0;
        const saldoPerUnit = availableInventory > 0 ? saldo / availableInventory : 0; // o "1600"
        const currentRealCostPerUnit = soldUnitsRealYtd > 0 ? spentTotal / soldUnitsRealYtd : 0;
        const remainingUnitsPlan = availableInventory;

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

        // ----- Contexto do mês selecionado -----
        const unitsTargetMonth = unitsTargetByMonth[endYM] || 0;
        const unitsSoldRealMonth = soldByMonth.get(endYM) || 0;
        const recommendedMonth = saldoPerUnit * unitsTargetMonth;       // o "24.000"
        const plannedBudgetMonth = plannedCostPerUnit * unitsTargetMonth;
        const monthContext = {
            yearMonth: endYM,
            unitsTargetMonth,
            unitsSoldRealMonth,
            plannedBudgetMonth,
            adjustedBudgetMonth: recommendedMonth,
            spentMonth: monthSpent,
            remainingBudgetMonth: recommendedMonth - monthSpent,
            // aliases consumidos pelo front atual
            monthBudget: recommendedMonth,
            monthSpent,
            monthRemaining: recommendedMonth - monthSpent,
        };

        // ----- Série mensal (no range) p/ gráficos/tendência da Fase 5 -----
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
        // Concluído: nada a comercializar (sem disponível e sem projeção futura/atual).
        // Senão: Em andamento (já gastou) ou Previsão Futura (ainda sem gasto). Admin pode forçar.
        const hasActivity = availableInventory > 0 || projectedUnitsFuture > 0;
        const autoStatus = !hasActivity ? 'concluido'
            : spentTotal > 0 ? 'em_andamento'
                : 'previsao_futura';
        const statusOverride = resolver.statusOverride(company.companyId);
        const status = statusOverride || autoStatus;

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
                blockedConsideredAvailable: blockedConsidered,
                availableInventory,

                // base de orçamento (vida útil)
                avgTicketGlobal: avgTicket,
                marketingPct: pct,
                custoLoja,
                unitsTargetTotal: totalUnits,          // "meta" = total de unidades (vida útil)
                projectedUnitsMonth: unitsTargetMonth, // unidades projetadas no mês selecionado (p/ filtro de exibição)
                revenueTargetTotal: totalUnits * avgTicket,
                budgetTotal,
                budgetUpToMonth: budgetTotal,         // compat: vida útil = total

                // realizado
                spentTotal,
                remainingBudgetTotal: saldo,
                pctInvested,
                soldUnitsRealYtd,

                // viabilidade por unidade
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

                monthContext,
            },
            months,
        };
    }

    /* ============================ Lista (por empresa) ============================ */
    async listEnterprisesViability({ year, upToMonth = null, startMonth = null, endMonth = null, aliasId = 'default' }) {
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
        const resolver = await buildMarketingResolver();

        // agrupa defaults por empresa (chave: company_id; sem idCompany → agrupa pelo próprio enterprise_key)
        const groups = new Map();
        for (const d of defaults) {
            const info = d.erp_id ? erpToCompany.get(String(d.erp_id)) : null;
            const companyId = info?.companyId ?? null;
            const groupKey = companyId != null ? `co:${companyId}` : `ek:${d.enterprise_key}`;
            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    companyId,
                    // Nome de exibição: prioriza o nome da PROJEÇÃO (enterprise_name_cache),
                    // depois o nome da empresa Sienge, depois o fallback.
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

        const results = [];
        for (const company of groups.values()) {
            const viability = await this.computeCompanyViability({ company, projection, range, resolver });
            const h = viability.header;
            // mostra só se há projeção no mês selecionado OU gasto de marketing em algum momento
            if (num(h.projectedUnitsMonth) <= 0 && num(h.spentTotal) <= 0) continue;

            results.push({
                companyId: company.companyId,
                erpId: h.erpId,
                displayId: h.displayId,
                enterpriseName: h.enterpriseName,
                costCenterIds: h.costCenterIds,
                header: h,
                months: viability.months,
            });
        }

        // maior orçamento primeiro
        results.sort((a, b) => num(b.header.budgetTotal) - num(a.header.budgetTotal));

        return {
            year: Number(String(endYM).slice(0, 4)),
            upToMonth: endYM,
            startMonth: startYM,
            endMonth: endYM,
            projectionId: projection.id,
            count: results.length,
            results,
        };
    }

    /* ===== Compat: viabilidade de 1 CC → resolve a empresa dele e devolve a da empresa ===== */
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
        const resolver = await buildMarketingResolver();
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
