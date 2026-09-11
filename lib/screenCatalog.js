// lib/screenCatalog.js
//
// As telas do Office que a Eme pode ABRIR (navigate_to_page) e para onde um
// alerta pode LINKAR (services/alerts/toolToRoute.js).
//
// A lista de rotas vivia como texto dentro da descrição da tool: quando uma
// tela mudava de endereço, a Eme continuava mandando a pessoa para a rota
// antiga (Boleto Caixa virou Ato e Parcelas em 23/08 e a tool ainda apontava
// /financeiro/boleto-caixa duas semanas depois), e telas novas simplesmente não
// existiam para ela (Correspondentes, Plano de Eventos, Checklists...).
//
// Espelha o navRegistry do front (src/config/navRegistry.js) mais as guias do
// Relatório Comercial. Só telas de USO entram: administração do sistema
// (Usuários, Alçadas, Sienge, Integridade...) fica de fora de propósito - a
// Eme não tem o que fazer nelas e o link só serviria para confundir.
//
// Renome de rota: a tela nova entra aqui E o caminho antigo vai para
// ROUTE_RENAMES (lib/ensurePermissionRouteRenames.js) - resolveScreenRoute()
// traduz o antigo sozinho, então um tool_call de alerta gravado com a rota
// velha continua abrindo a tela certa.
import { ROUTE_RENAMES } from './ensurePermissionRouteRenames.js';

export const SCREEN_CATALOG = [
    // Marketing
    { route: '/marketing/leads',          label: 'Leads',                    area: 'Marketing' },
    { route: '/marketing/events',         label: 'Eventos',                  area: 'Marketing' },
    { route: '/marketing/plano-eventos',  label: 'Plano de Eventos',         area: 'Marketing' },
    { route: '/marketing/stand-vendas',   label: 'Stand de Vendas',          area: 'Marketing' },
    { route: '/marketing/viabilidade',    label: 'Viabilidade',              area: 'Marketing' },
    { route: '/meta',                     label: 'Central Meta (campanhas, formulários e vínculos do CV, guias em ?tab=)', area: 'Marketing' },
    // Comercial
    { route: '/comercial/relatorios/faturamento',  label: 'Relatório de Faturamento',     area: 'Comercial' },
    { route: '/comercial/relatorios/projecao',     label: 'Vendas x Projeção',            area: 'Comercial' },
    { route: '/comercial/relatorios/precadastros', label: 'Pré-Cadastros',                area: 'Comercial' },
    { route: '/comercial/relatorios/reservas',     label: 'Reservas',                     area: 'Comercial' },
    { route: '/comercial/relatorios/leads',        label: 'Desempenho por Lead',          area: 'Comercial' },
    { route: '/comercial/relatorios/imobiliarias', label: 'Desempenho por Imobiliária',   area: 'Comercial' },
    { route: '/comercial/relatorios/corretores',   label: 'Desempenho por Corretor',      area: 'Comercial' },
    { route: '/comercial/projections',             label: 'Projeção de vendas (metas)',   area: 'Comercial' },
    { route: '/comercial/conditions',              label: 'Fichas Comerciais',            area: 'Comercial' },
    { route: '/comercial/mcmv',                    label: 'Minha Casa Minha Vida',        area: 'Comercial' },
    { route: '/comercial/aditivos',                label: 'Aditivos',                     area: 'Comercial' },
    { route: '/comercial/cancelamento-reservas',   label: 'Cancelamentos de reserva',     area: 'Comercial' },
    // CV CRM
    { route: '/crm/buildings',        label: 'Empreendimentos',        area: 'CV CRM' },
    { route: '/crm/imobiliarias',     label: 'Imobiliárias',           area: 'CV CRM' },
    { route: '/crm/correspondentes',  label: 'Correspondentes (CCAs)', area: 'CV CRM' },
    { route: '/crm/workflow/groups',  label: 'Grupos de Workflow',     area: 'CV CRM' },
    // Financeiro
    { route: '/financeiro/titulos',       label: 'Títulos (contas a pagar)', area: 'Financeiro' },
    { route: '/financeiro/custos',        label: 'Custos',                   area: 'Financeiro' },
    { route: '/financeiro/consulta-cef',  label: 'Consulta de nº CEF',       area: 'Financeiro' },
    { route: '/financeiro/cobranca/ato',  label: 'Ato e Parcelas (boletos Caixa do ato, link de cartão e parcelas mensais)', area: 'Financeiro' },
    { route: '/financeiro/paymentflow',   label: 'Fluxo de Pagamento',       area: 'Financeiro' },
    // Ferramentas
    { route: '/checklists',  label: 'Checklists',              area: 'Ferramentas' },
    { route: '/relatorios',  label: 'Relatórios da Eme',       area: 'Ferramentas' },
    { route: '/frota',       label: 'Veículo corporativo',     area: 'Ferramentas' },
    { route: '/validator',   label: 'Validador de Contratos',  area: 'Ferramentas' },
    // Academy
    { route: '/academy/panel',  label: 'Painel do Academy',    area: 'Academy' },
    { route: '/academy/kb',     label: 'Base de Conhecimento', area: 'Academy' },
    { route: '/academy/tracks', label: 'Trilhas',              area: 'Academy' },
    // Microsoft / pessoal
    { route: '/assistente',           label: 'Meu dia (assistente pessoal)',                   area: 'Recursos' },
    { route: '/microsoft/outlook',    label: 'Outlook',                                        area: 'Microsoft' },
    { route: '/microsoft/teams',      label: 'Teams (agenda; transcrições em ?tab=reunioes)',  area: 'Microsoft' },
    { route: '/microsoft/sharepoint', label: 'SharePoint',                                     area: 'Microsoft' },
    { route: '/microsoft/planner',    label: 'Planner',                                        area: 'Microsoft' },
    // Conta
    { route: '/mural',                 label: 'Mural de Avisos',          area: 'Conta' },
    { route: '/notifications',         label: 'Avisos e notificações',    area: 'Conta' },
    { route: '/settings/alerts',       label: 'Alertas',                  area: 'Conta' },
    { route: '/settings/organograma',  label: 'Organograma',              area: 'Conta' },
    { route: '/settings/Account',      label: 'Minha Conta',              area: 'Conta' },
    { route: '/report',                label: 'Reportar Problema',        area: 'Conta' },
];

const byRoute = new Map(SCREEN_CATALOG.map(s => [s.route.toLowerCase(), s]));
const renamesLower = Object.fromEntries(
    Object.entries(ROUTE_RENAMES).map(([de, para]) => [de.toLowerCase(), para])
);

/**
 * Rota canônica de uma tela, aceitando o caminho antigo (renomeado) e
 * diferença de caixa. null quando não é tela do catálogo.
 */
export function resolveScreenRoute(route) {
    let path = String(route || '').trim();
    if (!path) return null;
    // Guarda a query (?tab=..., ?section=...) para devolver junto.
    const q = path.indexOf('?');
    const query = q >= 0 ? path.slice(q) : '';
    if (q >= 0) path = path.slice(0, q);
    if (!path.startsWith('/')) path = `/${path}`;
    path = path.replace(/\/+$/, '') || '/';

    // Segue a cadeia de renomes (uma rota pode ter mudado mais de uma vez).
    let key = path.toLowerCase();
    for (let i = 0; i < 5 && renamesLower[key]; i++) key = renamesLower[key].toLowerCase();

    const tela = byRoute.get(key);
    return tela ? `${tela.route}${query}` : null;
}

export function screenLabel(route) {
    const canon = resolveScreenRoute(route);
    if (!canon) return null;
    return byRoute.get(canon.split('?')[0].toLowerCase())?.label || null;
}

/** Texto para a descrição de navigate_to_page: "Área: /rota (Nome), ...". */
export function describeScreenCatalog() {
    const porArea = new Map();
    for (const s of SCREEN_CATALOG) {
        if (!porArea.has(s.area)) porArea.set(s.area, []);
        porArea.get(s.area).push(`${s.route} (${s.label})`);
    }
    return [...porArea.entries()].map(([area, itens]) => `${area}: ${itens.join(', ')}.`).join(' ');
}

export default { SCREEN_CATALOG, resolveScreenRoute, screenLabel, describeScreenCatalog };
