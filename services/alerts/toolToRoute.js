// services/alerts/toolToRoute.js
//
// Mapeia uma chamada de tool da Eme (tool + args) para a MESMA rota que a IA
// usaria via `navigate_to_page` ao mostrar o dashboard daquele dado. Os filtros
// viram query string — a tela alvo já lê query params como filtros.
//
// Datas dinâmicas (placeholders {dynamic:'today'}) já vêm resolvidas pelo
// AlertReportService antes de chegar aqui.
//
// Casing das rotas confere com office.routes.js do front:
//   /marketing/Events           (capital E)
//   /marketing/leads
//   /comercial/buildings
//   /comercial/precadastros
//   /comercial/reservas-report
//   /comercial/mcmv

const TOOL_ROUTES = {
    query_leads:           '/marketing/leads',
    query_events:          '/marketing/Events',
    query_enterprises:     '/comercial/buildings',
    get_enterprise_detail: '/comercial/buildings',
    query_precadastros:    '/comercial/precadastros',
    query_reservas:        '/comercial/reservas-report',
    query_mcmv:            '/comercial/mcmv',
};

// Chaves dos args que NÃO devem virar query (controles internos da tool —
// não fazem sentido como filtro visual no dashboard)
const SKIP_KEYS = new Set([
    'group_by',
    'limit',
    'format',
    'metric',
    'visibility',
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

/**
 * @param {object} toolCall  { tool, args } — args já com placeholders resolvidos
 * @returns {string|null} link relativo, ex: '/marketing/leads?cidade=Sarandi&data_inicio=2026-05-10'
 *                        ou null se a tool não tem rota mapeada
 */
export function toolToRoute(toolCall) {
    if (!toolCall?.tool) return null;
    const route = TOOL_ROUTES[toolCall.tool];
    if (!route) return null;
    return `${route}${buildQueryString(toolCall.args || {})}`;
}

export default { toolToRoute };
