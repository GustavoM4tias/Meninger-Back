// services/alerts/toolToRoute.js
//
// Mapeia uma chamada de tool da Eme (tool + args) para uma rota do front com
// filtros pré-preenchidos como query string. Usado pra montar o link da
// notificação do alerta — clique no sino abre o relatório no contexto certo.
//
// Datas dinâmicas (placeholders como {dynamic:'today'}) são resolvidas pelo
// AlertReportService antes de chegar aqui — então args já vem com strings.

// Mapeamento tool → route base
const TOOL_ROUTES = {
    query_leads:        { route: '/marketing/leads',        section: 'Leads' },
    query_events:       { route: '/marketing/Events',       section: 'Geral' },
    query_enterprises:  { route: '/comercial/buildings',    section: 'Geral' },
    query_precadastros: { route: '/comercial/precadastros', section: 'Geral' },
    query_reservas:     { route: '/comercial/reservas',     section: 'Geral' },
    query_mcmv:         { route: '/comercial/mcmv',         section: 'Consulta' },
    get_enterprise_detail: { route: '/comercial/buildings', section: 'Geral' },
};

// Chaves de args que NÃO devem virar query (controles internos da tool)
const SKIP_KEYS = new Set([
    'group_by',
    'limit',
    'format',
    'metric',
    'incluir_painel',
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
 * @returns {string|null} link relativo (ex: '/marketing/leads?cidade=Sarandi&data_inicio=2026-05-10')
 *                        ou null se a tool não tem rota mapeada
 */
export function toolToRoute(toolCall) {
    if (!toolCall?.tool) return null;
    const map = TOOL_ROUTES[toolCall.tool];
    if (!map) return null;

    const qs = buildQueryString(toolCall.args || {});
    const baseQuery = map.section ? `?section=${encodeURIComponent(map.section)}` : '';

    if (!qs) return `${map.route}${baseQuery}`;
    if (!baseQuery) return `${map.route}${qs}`;
    // Combina section + filtros
    return `${map.route}${baseQuery}&${qs.slice(1)}`;
}

export default { toolToRoute };
