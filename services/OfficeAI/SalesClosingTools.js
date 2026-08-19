// services/OfficeAI/SalesClosingTools.js
//
// Tool da Eme sobre VENDAS CONSOLIDADAS (Fechamento do Faturamento):
//   - get_consolidated_sales: dados de venda de um mês. Se o mês está
//     CONSOLIDADO, devolve o snapshot congelado (número oficial, com data do
//     fechamento e divergências abertas). Se NÃO está, devolve um agregado
//     parcial calculado ao vivo, rotulado como sujeito a mudança.
//
// Regra de ouro do relatório: venda com data da instituição financeira conta,
// mesmo distratada depois (distrato = selo); compra e distrato no mesmo mês se
// anulam. Escopo de dados por usuário via accessScopeService.
import db from '../../models/sequelize/index.js';
import { registerTool } from './ToolRegistry.js';
import { getClosing, PERIOD_RE, periodBounds } from '../comercial/salesClosingService.js';
import { visibleErpIds } from '../permissions/accessScopeService.js';
import {
    effectiveFiDateSql,
    fiDateInRangeSql,
    loadSerieAdjustments,
    serieValueDelta
} from '../comercial/contractAdjustmentsService.js';

const fmtBRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);

function defaultPeriod() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Agregado parcial ao vivo (mês NÃO consolidado): mesmo recorte da visão
// padrão do dashboard, VGV pela soma das condições de pagamento (sem DC no
// líquido). Aproximado: não aplica regras finas de composição/comissão.
async function livePartialAggregate(period, scopeErpIds) {
    const { start, end } = periodBounds(period);
    const whereScope = scopeErpIds === null ? '' : ' AND sc.enterprise_id IN (:scopeErpIds)';
    // Mesma máscara de ajuste contábil do dashboard: a Eme não pode responder um
    // número diferente do que está na tela.
    const effectiveFiDate = effectiveFiDateSql('sc');

    const rows = await db.sequelize.query(`
        SELECT
            sc.id, sc.enterprise_id, sc.enterprise_name, sc.company_id, sc.company_name,
            sc.situation,
            COALESCE((SELECT SUM(NULLIF(pc->>'totalValue','')::numeric)
                      FROM jsonb_array_elements(sc.payment_conditions) pc), 0) AS gross_sum,
            COALESCE((SELECT SUM(NULLIF(pc->>'totalValue','')::numeric)
                      FROM jsonb_array_elements(sc.payment_conditions) pc
                      WHERE UPPER(COALESCE(pc->>'conditionTypeId','')) <> 'DC'), 0) AS net_sum,
            COALESCE(
                (SELECT NULLIF(c ->> 'id','') FROM jsonb_array_elements(sc.customers) c
                 WHERE (c ->> 'main')::boolean = true LIMIT 1),
                (SELECT NULLIF(c ->> 'id','') FROM jsonb_array_elements(sc.customers) c LIMIT 1)
            ) AS customer_id,
            COALESCE(
                (SELECT u ->> 'name' FROM jsonb_array_elements(sc.units) u
                 WHERE (u ->> 'main')::boolean = true LIMIT 1),
                (SELECT u ->> 'name' FROM jsonb_array_elements(sc.units) u LIMIT 1)
            ) AS unit_name
        FROM contracts sc
        WHERE ${fiDateInRangeSql('sc')}
          AND sc.situation IN ('Emitido', 'Cancelado')
          AND (
            sc.situation <> 'Cancelado'
            OR sc.cancellation_date IS NULL
            OR date_trunc('month', sc.cancellation_date) > date_trunc('month', ${effectiveFiDate})
          )
          AND NOT EXISTS (
            SELECT 1 FROM hidden_dashboard_enterprises h
            WHERE h.active = true AND h.enterprise_id = sc.enterprise_id
          )
          ${whereScope}
    `, {
        replacements: scopeErpIds === null ? { start, end } : { start, end, scopeErpIds },
        type: db.Sequelize.QueryTypes.SELECT
    });

    // Séries adicionadas/editadas por ajuste contábil: o SQL somou o JSONB cru,
    // então a diferença entra aqui.
    const serieAdj = await loadSerieAdjustments(rows.map(r => r.id));

    // Agrupa contratos em VENDAS (cliente+unidade+empreendimento), como o dashboard.
    const sales = new Map();
    for (const r of rows) {
        const key = `${r.customer_id}|${r.unit_name}|${r.enterprise_id}|${r.company_id}`;
        const s = sales.get(key) || { net: 0, gross: 0, enterprise_name: r.enterprise_name, distratada: true };
        const delta = serieValueDelta(serieAdj.get(String(r.id)) || []);
        s.net += (Number(r.net_sum) || 0) + delta.exceptDc;
        s.gross += (Number(r.gross_sum) || 0) + delta.all;
        if (r.situation !== 'Cancelado') s.distratada = false;
        sales.set(key, s);
    }

    const byEnterprise = new Map();
    let net = 0, gross = 0, distratadas = 0;
    for (const s of sales.values()) {
        net += s.net; gross += s.gross;
        if (s.distratada) distratadas += 1;
        const e = byEnterprise.get(s.enterprise_name) || { count: 0, net: 0 };
        e.count += 1; e.net += s.net;
        byEnterprise.set(s.enterprise_name, e);
    }

    return {
        count: sales.size,
        vgv_net: net,
        vgv_gross: gross,
        distratadas,
        by_enterprise: [...byEnterprise.entries()]
            .map(([name, v]) => ({ name, count: v.count, vgv_net: v.net }))
            .sort((a, b) => b.vgv_net - a.vgv_net)
    };
}

registerTool({
    name: 'get_consolidated_sales',
    description: 'Consulta os dados de VENDAS (Faturamento) de um mês. Se o mês está CONSOLIDADO pelo fechamento oficial, devolve os números CONGELADOS (fonte segura — pode afirmar com confiança, citando a data do fechamento). Se NÃO está consolidado, devolve um agregado PARCIAL ao vivo: você DEVE avisar que o período não está consolidado e que os números são parciais/aproximados e podem mudar. Use quando perguntarem "quanto vendemos em X", "VGV de tal mês", "vendas por empreendimento no mês". NUNCA invente números.',
    parameters: {
        type: 'object',
        properties: {
            period: { type: 'string', description: 'Mês no formato YYYY-MM (ex: 2026-01). Padrão: mês atual.' },
        },
    },
    requiredPermissions: ['/comercial/relatorios/faturamento'],
    contexts: ['OFFICE'],
    async handler(user, args) {
        const period = PERIOD_RE.test(String(args?.period || '')) ? args.period : defaultPeriod();

        // Escopo de acesso: null = admin (tudo); [] = nada visível (fail-closed)
        const scope = await visibleErpIds(user);
        if (scope && !scope.length) {
            return {
                result: { message: 'Este usuário não tem empreendimentos liberados no escopo de acesso — diga que não há dados visíveis para ele.' },
                resultCount: 0,
            };
        }
        const scopeSet = scope === null ? null : new Set(scope.map(Number));

        const closing = await getClosing(period);

        if (closing) {
            // Números congelados; escopo aplicado sobre as linhas do snapshot.
            const lines = (closing.lines || []).filter(l =>
                scopeSet === null || scopeSet.has(Number(l.enterprise_id))
            );
            const net = lines.reduce((s, l) => s + (Number(l.value_net) || 0), 0);
            const gross = lines.reduce((s, l) => s + (Number(l.value_gross) || 0), 0);
            const distratadas = lines.filter(l => l.distratada).length;
            const byEnt = new Map();
            for (const l of lines) {
                const e = byEnt.get(l.enterprise_name) || { count: 0, net: 0 };
                e.count += 1; e.net += Number(l.value_net) || 0;
                byEnt.set(l.enterprise_name, e);
            }
            const sorted = [...byEnt.entries()].sort((a, b) => b[1].net - a[1].net);
            const openDivs = (closing.divergences || []).filter(d => d.status === 'open').length;
            const scoped = scopeSet !== null;

            return {
                result: {
                    period,
                    consolidado: true,
                    consolidated_at: closing.consolidated_at,
                    consolidated_by: closing.consolidated_by_name,
                    version: closing.version,
                    vendas: lines.length,
                    vgv: fmtBRL(net),
                    vgv_mais_dc: fmtBRL(gross),
                    vendas_distratadas_depois: distratadas,
                    divergencias_abertas: openDivs,
                    type: 'chart',
                    chartType: 'bar',
                    title: `Vendas consolidadas — ${period}`,
                    subtitle: `${lines.length} venda(s) · ${fmtBRL(net)}`,
                    labels: sorted.slice(0, 12).map(([k]) => k),
                    data: sorted.slice(0, 12).map(([, v]) => Math.round(v.net)),
                    message: `Mês ${period} CONSOLIDADO (fechamento v${closing.version} em ${new Date(closing.consolidated_at).toLocaleDateString('pt-BR')}${closing.consolidated_by_name ? ` por ${closing.consolidated_by_name}` : ''}). Números OFICIAIS e congelados: ${lines.length} venda(s), VGV ${fmtBRL(net)} (VGV+DC ${fmtBRL(gross)}).${distratadas ? ` ${distratadas} venda(s) foram distratadas depois, mas CONTAM no período (regra oficial).` : ''}${openDivs ? ` ATENÇÃO: há ${openDivs} divergência(s) aberta(s) detectada(s) nos dados de origem após o fechamento — mencione isso e aponte o menu Consolidação do Faturamento (/comercial/relatorios/faturamento, admin).` : ''}${scoped ? ' Valores já filtrados pelo escopo de acesso do usuário.' : ''} Responda com base SOMENTE nestes dados.`,
                },
                resultCount: lines.length,
                filtersApplied: { period },
            };
        }

        // Não consolidado: parcial ao vivo, com aviso obrigatório.
        const partial = await livePartialAggregate(period, scope);
        return {
            result: {
                period,
                consolidado: false,
                vendas_parcial: partial.count,
                vgv_parcial: fmtBRL(partial.vgv_net),
                vgv_mais_dc_parcial: fmtBRL(partial.vgv_gross),
                vendas_distratadas_depois: partial.distratadas,
                type: 'chart',
                chartType: 'bar',
                title: `Vendas (parcial) — ${period}`,
                subtitle: `${partial.count} venda(s) · ${fmtBRL(partial.vgv_net)} · NÃO consolidado`,
                labels: partial.by_enterprise.slice(0, 12).map(e => e.name),
                data: partial.by_enterprise.slice(0, 12).map(e => Math.round(e.vgv_net)),
                message: `O mês ${period} NÃO está consolidado. AVISE ISSO PRIMEIRO, com destaque: os números abaixo são PARCIAIS e APROXIMADOS (cálculo direto dos contratos, sem as regras finas de composição/comissão do dashboard) e PODEM MUDAR até o fechamento oficial. Parcial: ${partial.count} venda(s), VGV ~${fmtBRL(partial.vgv_net)}. Para o número oficial, um admin consolida o mês no menu Consolidação do Faturamento (/comercial/relatorios/faturamento).`,
            },
            resultCount: partial.count,
            filtersApplied: { period },
        };
    },
});
