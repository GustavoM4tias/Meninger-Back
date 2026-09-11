// services/alerts/toolToRoute.js
//
// Mapeia uma chamada de tool da Eme (tool + args) para a MESMA rota que a IA
// usaria via `navigate_to_page` ao mostrar o dashboard daquele dado. Os filtros
// viram query string — a tela alvo já lê query params como filtros.
//
// Datas dinâmicas (placeholders {dynamic:'today'}) já vêm resolvidas pelo
// AlertReportService antes de chegar aqui.
//
// De onde sai a rota, nesta ordem:
//   1. TOOL_ROUTES — só as tools cuja TELA não é a mesma da alçada (ou que
//      precisam de uma guia específica). Antes este mapa era a única fonte, com
//      7 tools; as outras 70 mandavam o alerta sem link nenhum.
//   2. requiredPermissions[0] da tool no registry — para a maioria, a tela que
//      dá a alçada é exatamente a tela do dado.
//   3. LEGACY_TOOL_ROUTES — mesma ideia para as tools do mapa legado.
// O resultado passa pelo catálogo de telas (lib/screenCatalog.js): rota
// renomeada vira a nova, rota que não é tela vira null (sem link).
import { findTool } from '../OfficeAI/ToolRegistry.js';
import { LEGACY_TOOL_ROUTES } from '../OfficeAI/OfficeChatService.js';
import { resolveScreenRoute } from '../../lib/screenCatalog.js';

const TOOL_ROUTES = {
    query_leads:              '/marketing/leads',
    query_events:             '/marketing/events',
    query_enterprises:        '/crm/buildings',
    get_enterprise_detail:    '/crm/buildings',
    query_precadastros:       '/comercial/relatorios/precadastros',
    query_reservas:           '/comercial/relatorios/reservas',
    query_mcmv:               '/comercial/mcmv',
    // A alçada é a da tela de Imobiliárias, mas o dado mora numa guia.
    imobiliarias_search:      '/crm/imobiliarias?tab=imobiliarias',
    imobiliarias_cadastros:   '/crm/imobiliarias?tab=cadastros',
    // O ranking tem uma guia por dimensão; sem dimensão cai em Corretores.
    query_desempenho_vendas:  '/comercial/relatorios/corretores',
};

// Guia do Relatório Comercial que corresponde a cada dimensão do ranking.
const DIMENSAO_ROUTE = {
    corretor:       '/comercial/relatorios/corretores',
    imobiliaria:    '/comercial/relatorios/imobiliarias',
    midia:          '/comercial/relatorios/leads',
    origem:         '/comercial/relatorios/leads',
    campanha:       '/comercial/relatorios/leads',
    empreendimento: '/comercial/relatorios/faturamento',
};

// Chaves dos args que NÃO devem virar query (controles internos da tool —
// não fazem sentido como filtro visual no dashboard)
const SKIP_KEYS = new Set([
    'group_by',
    'limit',
    'limite',
    'format',
    'metric',
    'visibility',
    'dimensao',
    'valor',
    'foco',
]);

function buildQueryString(args) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args || {})) {
        if (SKIP_KEYS.has(k)) continue;
        if (v === null || v === undefined || v === '') continue;
        // Placeholders dinâmicos não resolvidos — pula
        if (typeof v === 'object') continue;
        params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : '';
}

function baseRouteOf(tool, args) {
    if (tool === 'query_desempenho_vendas' && DIMENSAO_ROUTE[args?.dimensao]) {
        return DIMENSAO_ROUTE[args.dimensao];
    }
    if (TOOL_ROUTES[tool]) return TOOL_ROUTES[tool];
    const reg = findTool(tool);
    if (reg?.requiredPermissions?.length) return reg.requiredPermissions[0];
    if (LEGACY_TOOL_ROUTES[tool]) return LEGACY_TOOL_ROUTES[tool];
    return null;
}

/**
 * @param {object} toolCall  { tool, args } — args já com placeholders resolvidos
 * @returns {string|null} link relativo, ex: '/marketing/leads?cidade=Sarandi&data_inicio=2026-05-10'
 *                        ou null se a tool não leva a nenhuma tela
 */
export function toolToRoute(toolCall) {
    if (!toolCall?.tool) return null;
    const base = resolveScreenRoute(baseRouteOf(toolCall.tool, toolCall.args));
    if (!base) return null;
    const qs = buildQueryString(toolCall.args || {});
    if (!qs) return base;
    // A base pode já trazer ?tab=...: emenda com & em vez de abrir outra query.
    return base.includes('?') ? `${base}&${qs.slice(1)}` : `${base}${qs}`;
}

export default toolToRoute;
