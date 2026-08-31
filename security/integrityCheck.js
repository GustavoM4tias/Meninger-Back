// security/integrityCheck.js
//
// VALIDADOR DE INTEGRIDADE DE SEGURANÇA.
//
// Varre o app Express em execução e o banco, conferindo que o padrão de
// acesso (spec em _estudo/acessos/README.md) está sendo cumprido:
//
//   1. Toda rota /api/* tem autenticação (exceto allowlist pública explícita).
//   2. Rotas /api/admin/* têm requireAdmin (exceto allowlist).
//   3. TODA rota autenticada tem requireRoutePermission ou requireAdmin — ou
//      uma linha em NO_SCREEN_PERMISSION dizendo por que é pessoal/livre.
//      (fail-closed desde 2026-08-19; antes só 14 prefixos eram cobrados)
//   3b. Ações de tela (lib/screenCapabilities.js): toda ação declarada tem
//      alguma rota de API que a exige — senão o botão some da tela e a API
//      continua aberta.
//   4. Tools da Eme: todas registradas com permissão declarada; tools legadas
//      todas mapeadas no LEGACY_TOOL_ROUTES (fail-closed cobre o resto).
//   4b. Telas travadas como "somente admin" na tela de Alçadas (route_policies):
//      panorama do que está travado + perfis/exceções que ainda citam a tela.
//   5. Banco: tabelas do modelo de acesso existem; usuários ativos com FKs de
//      cargo/cidade casadas; grants órfãos; perfis inativos referenciados.
//   6. Legado: acusa se a tabela enterprise_cities ainda existe (deve sumir
//      no boot seguinte à semente do registro unificado).
//
// Como rodar: tela admin /settings/integrity (botão "Rodar validação") ou
// POST /api/admin/integrity-check. Um resumo também sai no log de boot.
//
// FUNCIONALIDADE NOVA FORA DO PADRÃO ACENDE FAIL AQUI. Se a exceção for
// legítima (webhook assinado, rota pública), adicione na allowlist COM
// comentário do porquê.

import db from '../models/sequelize/index.js';
import { getRegisteredTools } from '../services/OfficeAI/ToolRegistry.js';
import { listRoutePolicies, normalizeRoute } from '../services/permissions/routePolicyService.js';
import { SCREEN_CAPABILITIES } from '../lib/screenCapabilities.js';

let _app = null;
export function registerApp(app) { _app = app; }

// ── Allowlists (cada entrada precisa de motivo) ──────────────────────────────

// Prefixos de rota que PODEM ficar sem autenticação:
const PUBLIC_PREFIXES = [
    '/api/auth',                 // login/refresh/reset — é o próprio fluxo de autenticação
    '/api/microsoft',            // OAuth redirect da Microsoft + webhook do Graph
                                 // (a Microsoft chama sem JWT; a autenticação do
                                 // webhook é o clientState, conferido no controller)
    '/api/bolao/public',         // bolão público do site
    '/api/public',               // landing pages públicas (lp.menin)
    '/api/marketing/public',     // formulários públicos de captação
    '/api/marketing/webhook',    // webhook Meta (assinado por App Secret)
    '/api/whatsapp/webhook',     // webhook Meta WhatsApp (assinado)
    '/api/eme-atende/public',    // webhook/fluxo público do Eme Atende
    '/api/reports/public',       // relatórios compartilhados /r/<token> (token na URL)
    '/api/realestate/public',    // cadastro público de imobiliária (token na URL)
    '/api/correspondents/public', // auto-cadastro de equipe correspondente (token na URL)
    '/api/boleto-caixa/webhook', // webhook do CV (Boleto Caixa)
    '/api/cancelamento-reservas/webhook', // webhook do CV (cancelamento de reservas)
    '/api/contracts/webhook',    // webhook CONTRATOS_IA do CV (segredo na URL, em
                                 // contract_webhook_settings; a situação do repasse
                                 // é relida do CV antes de qualquer análise)
    '/api/meta-app-oauth',       // callback OAuth Meta (state assinado no controller)
    '/api/ai/validator',         // job server-to-server (protegido por token interno — security/internalJobToken)
    '/api/cv/banners',           // banners exibidos na TELA DE LOGIN (pré-autenticação; sem dado de negócio)
    '/api/cv/webhook',           // webhook de dados do CV (reservas/repasses). Token por
                                 // funcionalidade em cv_webhook_endpoints, conferido em
                                 // tempo constante; o corpo é tratado como campainha —
                                 // só o id é lido e o dado vem de nova busca no CV.
];

// Rotas autenticadas que NÃO carregam alçada de tela por decisão de desenho.
// Cada entrada precisa de motivo — é aqui que se declara "isto é pessoal/livre",
// e o que não estiver aqui nem tiver requireRoutePermission/requireAdmin ACENDE.
//
// A regra era o contrário até 2026-08-19: só uma lista curta de prefixos era
// cobrada (DATA_PREFIXES), então 43 dos 57 prefixos montados NUNCA eram
// checados — módulo novo nascia sem alçada e ninguém acusava. Agora o padrão é
// fail-closed: toda rota autenticada precisa de alçada, de admin, ou de uma
// linha aqui explicando por quê.
const NO_SCREEN_PERMISSION = [
    // Sessão e identidade do próprio usuário
    ['/api/auth', 'fluxo de autenticação/sessão'],
    ['/api/permissions/me', 'as próprias alçadas do solicitante'],
    ['/api/favorite', 'favoritos pessoais do usuário'],
    ['/api/notifications', 'caixa de notificações PESSOAL (cada um vê a sua)'],
    ['/api/platform', 'marca pessoal de "já li as novidades" (mural de atualizações da plataforma)'],
    ['/api/push', 'assinatura de push do dispositivo do próprio usuário'],
    ['/api/alerts', 'alertas PESSOAIS (tela /settings/alerts é permissionManaged:false)'],
    ['/api/support', 'reportar problema — qualquer um abre; a leitura é admin'],
    ['/api/uploads', 'upload genérico de anexo do próprio usuário'],
    ['/api/report-exports', 'POST registra a PRÓPRIA exportação; o GET da trilha já é admin'],
    // Só a data do espelho do Sienge: um carimbo de tempo e um booleano de
    // "passou do limite de idade", sem nenhuma linha do ERP dentro. Existe para
    // que TODA tela que lê o backup (Custos/Títulos, Recebimentos do Ato,
    // Inadimplência, Stand de Vendas) possa dizer de quando é o número que está
    // mostrando - amarrar isso à alçada de uma tela específica obrigaria a
    // editar esta rota a cada tela nova que passasse a ler o espelho. As demais
    // rotas de /api/sienge/backups continuam admin-only.
    ['/api/sienge/backups/freshness', 'só a data do espelho (carimbo de tempo, sem dado do ERP); toda tela que lê o backup precisa dizer de quando é o número'],
    // Telas declaradas como sempre livres no navRegistry
    ['/api/comunicados', 'Mural de Avisos é permissionManaged:false (broadcast interno)'],
    ['/api/bolao', 'bolão interno, sem dado de negócio'],
    ['/api/academy', 'Academy é permissionManaged:false (KB/Trilhas abertas)'],
    ['/api/academy-chat', 'assistente do Academy, mesmo escopo do módulo'],
    // Microsoft: cada handler usa o token DELEGADO do próprio usuário, então o
    // que ele enxerga já é o que a conta Microsoft dele enxerga.
    //
    // EXCEÇÃO DENTRO DA EXCEÇÃO: /api/microsoft/outlook/* usa token de
    // APLICAÇÃO, não o delegado — o Graph aceitaria a caixa de qualquer pessoa.
    // Lá a justificativa acima NÃO vale, e por isso aquelas rotas têm
    // requireCapability('/microsoft/outlook', ...) de verdade, e o controller
    // amarra a caixa ao microsoft_id de quem pediu (_resolveMailbox).
    // Se alguém acrescentar rota de e-mail sem capability, é regressão.
    ['/api/microsoft', 'Graph com o token delegado do próprio usuário (exceto /outlook, que usa capability)'],
    // A Eme não é porta de entrada: cada tool declara requiredPermissions e o
    // ToolRegistry recusa a que o usuário não tem (fail-closed).
    ['/api/office-chat', 'alçada é validada tool a tool no ToolRegistry'],
    ['/api/reports', 'Relatórios da Eme: tela livre; builder e escrita já exigem admin'],
    // Assistente pessoal: TODA rota devolve só o que é da PRÓPRIA pessoa, e o
    // id sai do token - nenhuma delas aceita user_id do cliente. Exigir alçada
    // criaria o absurdo de alguém não poder anotar um lembrete para si mesmo,
    // pelo mesmo motivo que as preferências de notificação não exigem. A tela
    // é permissionManaged:false no navRegistry, coerente com isto.
    // Se alguém acrescentar aqui uma rota que leia a lista de OUTRA pessoa, é
    // regressão e esta justificativa deixa de valer.
    ['/api/assistente', 'lista da própria pessoa; o id vem do token, nunca do cliente'],
    // Casos pontuais herdados
    ['/api/sienge/contracts/sync/status', 'status de sync, sem dado de negócio'],
    ['/api/cv/banners', 'banners de campanha exibidos na home'],
    ['/api/mcmv/ai-query', 'consumida pela Eme (function calling), tabela pública MCMV'],
    ['/api/event-plans/settings', 'admin-only no controller (config do Plano de Eventos)'],
    ['/api/event-plans/auth-profiles', 'admin-only no controller (perfis de alçada)'],
    ['/api/event-plans/permissions', 'devolve só o que o PRÓPRIO solicitante pode fazer'],
    ['/api/event-plans/users', 'admin-only no controller (monta os perfis de alçada)'],
];

// Lacunas CONHECIDAS, com decisão pendente. Saem como WARN (não fail) para não
// pintar a tela de vermelho permanente, mas continuam visíveis até resolver.
// Tirar daqui = ou ganhou alçada, ou virou linha em NO_SCREEN_PERMISSION.
// (Vazio desde 2026-08-19: a única pendência era /api/marketing-approvals, e o
// módulo de Aprovações foi removido inteiro.)
const PENDING_SCREEN_PERMISSION = [];

// ── Introspecção do router ───────────────────────────────────────────────────

function layerPrefix(layer) {
    // Express guarda o prefixo de router.use() em regexp; extrai o caminho.
    if (layer.path) return layer.path;
    const src = layer.regexp?.source || '';
    if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
    const m = src
        .replace('\\/?(?=\\/|$)', '')
        .replace(/^\^/, '')
        .replace(/\\\//g, '/')
        .replace(/\$$/, '');
    return m.startsWith('/') ? m : '';
}

function middlewareNames(routeLayer) {
    return (routeLayer.route?.stack || []).map(l => ({
        name: l.handle?.name || '<anonymous>',
        isRoutePermission: !!l.handle?._isRoutePermission,
        isAdminGate: !!l.handle?._isAdminGate,
        capability: l.handle?._capability || null,
        requiredRoutes: l.handle?._requiredRoutes || null,
    }));
}

export function collectRoutes(app = _app) {
    const out = [];
    const walk = (stack, prefix, inherited) => {
        for (const layer of stack || []) {
            if (layer.route) {
                const methods = Object.keys(layer.route.methods || {}).map(m => m.toUpperCase());
                const mws = middlewareNames(layer);
                out.push({
                    path: prefix + layer.route.path,
                    methods,
                    middlewares: [...inherited, ...mws],
                });
            } else if (layer.name === 'router' && layer.handle?.stack) {
                const pfx = prefix + layerPrefix(layer);
                walk(layer.handle.stack, pfx, inherited);
            } else if (layer.handle && layer.regexp && layer.name !== 'router') {
                // router.use(mw) — herda para as rotas seguintes do MESMO stack.
                // Aproximação: registra como herdado dali em diante.
                inherited = [...inherited, {
                    name: layer.handle?.name || '<anonymous>',
                    isRoutePermission: !!layer.handle?._isRoutePermission,
                    isAdminGate: !!layer.handle?._isAdminGate,
                    requiredRoutes: layer.handle?._requiredRoutes || null,
                    viaUse: true,
                    usePrefix: prefix + layerPrefix(layer),
                }];
            }
        }
    };
    walk(app?._router?.stack, '', []);
    return out;
}

function hasAuth(r) {
    return r.middlewares.some(m =>
        (m.name === 'authenticate' && (!m.viaUse || r.path.startsWith(m.usePrefix || ''))));
}
function hasAdmin(r) {
    return r.middlewares.some(m =>
        ((m.name === 'requireAdmin' || m.name === 'adminOnly' || m.isAdminGate)
            && (!m.viaUse || r.path.startsWith(m.usePrefix || ''))));
}
function hasRoutePermission(r) {
    return r.middlewares.some(m =>
        (m.isRoutePermission && (!m.viaUse || r.path.startsWith(m.usePrefix || ''))));
}
function inList(path, list) {
    return list.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p));
}
/** Motivo declarado para a rota ficar sem alçada, ou null. Casa o prefixo mais específico. */
function matchReason(path, pairs) {
    let best = null;
    for (const [prefix, reason] of pairs) {
        if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix)) {
            if (!best || prefix.length > best.prefix.length) best = { prefix, reason };
        }
    }
    return best?.reason || null;
}

// ── Checks ───────────────────────────────────────────────────────────────────

async function checkRoutes(app) {
    const routes = collectRoutes(app).filter(r => r.path.startsWith('/api'));
    const noAuth = [];
    const adminExposed = [];
    const dataNoPermission = [];
    const dataPending = [];

    for (const r of routes) {
        const key = `${r.methods.join(',')} ${r.path}`;
        if (inList(r.path, PUBLIC_PREFIXES)) continue;

        if (!hasAuth(r)) { noAuth.push(key); continue; }

        if (r.path.startsWith('/api/admin')) {
            // exceções documentadas: leituras consumidas por telas não-admin
            const adminReadAllow = ['/api/admin/hidden-enterprises', '/api/admin/stage-commission-rules',
                '/api/admin/enterprise-value-rules', '/api/admin/enterprise-erp-links',
                '/api/admin/enterprise-erp-links/pendentes', '/api/admin/tr-satellite-enterprises'];
            const isReadAllowed = r.methods.every(m => m === 'GET') && adminReadAllow.includes(r.path);
            if (!hasAdmin(r) && !isReadAllowed) adminExposed.push(key);
            continue;
        }

        // Fail-closed: rota autenticada sem alçada e sem admin só passa se
        // estiver declarada como pessoal/livre (com motivo).
        if (hasRoutePermission(r) || hasAdmin(r)) continue;
        const declared = matchReason(r.path, NO_SCREEN_PERMISSION);
        if (declared) continue;
        const pending = matchReason(r.path, PENDING_SCREEN_PERMISSION);
        if (pending) { dataPending.push(`${key} — ${pending}`); continue; }
        dataNoPermission.push(key);
    }

    return [
        {
            id: 'routes-auth', name: 'Rotas de API com autenticação',
            status: noAuth.length ? 'fail' : 'ok',
            details: noAuth,
            summary: noAuth.length ? `${noAuth.length} rota(s) sem autenticação fora da allowlist` : `${routes.length} rotas verificadas`,
        },
        {
            id: 'routes-admin', name: 'Rotas /api/admin com requireAdmin',
            status: adminExposed.length ? 'fail' : 'ok',
            details: adminExposed,
            summary: adminExposed.length ? `${adminExposed.length} rota(s) admin sem requireAdmin` : 'todas as rotas admin protegidas',
        },
        {
            id: 'routes-permission', name: 'Rotas de dados com alçada (requireRoutePermission)',
            status: dataNoPermission.length ? 'fail' : (dataPending.length ? 'warn' : 'ok'),
            details: [
                ...dataNoPermission,
                ...dataPending.map(d => `pendente de decisão: ${d}`),
            ],
            summary: dataNoPermission.length
                ? `${dataNoPermission.length} rota(s) autenticada(s) sem alçada nem admin fora da allowlist`
                : (dataPending.length
                    ? `${dataPending.length} rota(s) com lacuna conhecida aguardando decisão`
                    : 'todas as rotas autenticadas com alçada, admin ou motivo declarado'),
        },
    ];
}

/**
 * Capacidades declaradas x cobradas.
 *
 * Ação que existe em lib/screenCapabilities.js mas nenhuma rota exige é um
 * botão escondido sem tranca atrás: a tela some, a API continua aberta. Sai
 * como warn porque existe caso legítimo (ação puramente visual, sem endpoint
 * próprio) — mas tem que ser uma decisão consciente, não esquecimento.
 */
async function checkCapabilities(app) {
    const declared = [];
    for (const [route, actions] of Object.entries(SCREEN_CAPABILITIES)) {
        for (const [action, rule] of Object.entries(actions)) declared.push({ route, action, rule });
    }

    const enforced = new Set();   // (rota::ação) cobrada por requireCapability
    const screenGated = new Set(); // telas cobradas por qualquer gate de alçada
    for (const r of collectRoutes(app)) {
        for (const m of r.middlewares) {
            if (m.capability) enforced.add(`${m.capability.route}::${m.capability.action}`);
            for (const req of (m.requiredRoutes || [])) screenGated.add(String(req).toLowerCase());
        }
    }

    // Ação com regra 'screen' também está cumprida quando a TELA é exigida por
    // requireRoutePermission (é o mesmo gate, escrito do jeito antigo). O que
    // não pode passar em branco é ação 'admin' declarada e nunca cobrada: aí a
    // tela esconde o botão e a API fica aberta.
    const semRota = declared
        .filter(d => !enforced.has(`${d.route}::${d.action}`))
        .filter(d => !(d.rule === 'screen' && screenGated.has(d.route.toLowerCase())))
        .map(d => `${d.route} → "${d.action}" (${d.rule}) declarada e nenhuma rota de API a exige`);

    return [{
        id: 'screen-capabilities', name: 'Ações de tela declaradas x cobradas na API',
        status: semRota.length ? 'warn' : 'ok',
        details: semRota,
        summary: semRota.length
            ? `${semRota.length} ação(ões) sem enforcement na API`
            : `${declared.length} ações em ${Object.keys(SCREEN_CAPABILITIES).length} tela(s), todas cobradas`,
    }];
}

async function checkEmeTools() {
    const details = [];
    // Tools do registry: precisam declarar requiredPermissions (array) — vazio é
    // decisão consciente, mas listamos como warn informativo se sem admin/perm.
    const open = [];
    for (const t of getRegisteredTools()) {
        if (!Array.isArray(t.requiredPermissions)) details.push(`${t.name}: requiredPermissions ausente`);
        else if (!t.requiredPermissions.length && !t.adminOnly) open.push(t.name);
    }
    // Tools legadas: todas precisam estar no mapa (fail-closed cobre, mas tool
    // fora do mapa fica INDISPONÍVEL — sinal de esquecimento).
    let legacyUnmapped = [];
    try {
        const { TOOLS, LEGACY_TOOL_ROUTES } = await import('../services/OfficeAI/OfficeChatService.js');
        legacyUnmapped = [...TOOLS.keys()].filter(n => !(n in LEGACY_TOOL_ROUTES));
    } catch (e) {
        details.push(`falha ao inspecionar tools legadas: ${e.message}`);
    }

    const fail = details.length > 0 || legacyUnmapped.length > 0;
    return [{
        id: 'eme-tools', name: 'Tools da Eme com permissão declarada',
        status: fail ? 'fail' : (open.length ? 'warn' : 'ok'),
        details: [
            ...details,
            ...legacyUnmapped.map(n => `tool legada sem mapa de alçada (ficará negada): ${n}`),
            ...open.map(n => `aberta a qualquer autenticado (conferir se é intencional): ${n}`),
        ],
        summary: fail ? 'tools fora do padrão' : `${getRegisteredTools().length} tools do registry ok`,
    }];
}

// Telas travadas como "somente admin" pela tela de Alçadas (route_policies).
// A trava vale de verdade porque as rotas efetivas já saem sem elas — este
// check é o espelho: mostra o que está travado e cobra a limpeza dos perfis e
// exceções que ainda listam a tela (não dá acesso, mas confunde quem lê).
async function checkRoutePolicies() {
    let policies = [];
    try {
        policies = await listRoutePolicies();
    } catch (err) {
        return [{
            id: 'route-policies', name: 'Telas travadas como somente admin',
            status: 'warn', details: [`falha ao ler route_policies: ${err.message}`],
            summary: 'não foi possível ler as políticas de tela',
        }];
    }

    const locked = policies.filter(p => p.adminOnly);
    const lockedSet = new Set(locked.map(p => normalizeRoute(p.route)));
    const leftovers = [];

    if (lockedSet.size) {
        const profiles = await db.PermissionProfile.findAll({
            where: { active: true }, attributes: ['name', 'routes'], raw: true,
        });
        for (const p of profiles) {
            const hit = (p.routes || []).filter(r => lockedSet.has(normalizeRoute(r)));
            if (hit.length) leftovers.push(`perfil "${p.name}" ainda lista: ${hit.join(', ')}`);
        }

        const perms = await db.UserPermission.findAll({
            attributes: ['userId', 'routes_extra'], raw: true,
        });
        for (const perm of perms) {
            const hit = (perm.routes_extra || []).filter(r => lockedSet.has(normalizeRoute(r)));
            if (hit.length) leftovers.push(`exceção do usuário ${perm.userId} ainda lista: ${hit.join(', ')}`);
        }
    }

    return [{
        id: 'route-policies', name: 'Telas travadas como somente admin (tela de Alçadas)',
        status: leftovers.length ? 'warn' : 'info',
        details: [
            ...locked.map(p => `${p.route} — travada por ${p.updatedBy || 'admin'}${p.note ? ` (${p.note})` : ''}`),
            ...leftovers,
        ],
        summary: locked.length
            ? `${locked.length} tela(s) exclusiva(s) de admin por configuração${leftovers.length ? ` · ${leftovers.length} referência(s) residual(is) em perfis/exceções` : ''}`
            : 'nenhuma tela travada pela tela de Alçadas',
    }];
}

async function checkDatabase() {
    const checks = [];
    const q = async (sql, repl = {}) => {
        const [rows] = await db.sequelize.query(sql, { replacements: repl });
        return rows;
    };

    // Legado: enterprise_cities deve ser dropada após a semente do registro
    const [legacyTbl] = await q(`SELECT 1 AS ok FROM pg_tables WHERE schemaname='public' AND tablename='enterprise_cities'`);
    checks.push({
        id: 'db-legacy-enterprise-cities', name: 'Tabela legada enterprise_cities removida',
        status: legacyTbl ? 'warn' : 'ok',
        details: legacyTbl ? ['enterprise_cities ainda existe — será dropada automaticamente no próximo boot (após a semente do registro unificado)'] : [],
        summary: legacyTbl ? 'ainda presente (aguardando drop automático)' : 'removida',
    });

    // Tabelas do modelo de acesso
    const tables = await q(`SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND tablename IN ('enterprises','companies','enterprise_grants','user_permissions','permission_profiles')`);
    const found = new Set(tables.map(t => t.tablename));
    const missing = ['enterprises', 'companies', 'enterprise_grants', 'user_permissions', 'permission_profiles']
        .filter(t => !found.has(t));
    checks.push({
        id: 'db-tables', name: 'Tabelas do modelo de acesso',
        status: missing.length ? 'fail' : 'ok',
        details: missing.map(t => `tabela ausente: ${t}`),
        summary: missing.length ? `${missing.length} tabela(s) ausente(s)` : 'todas presentes',
    });

    if (!missing.length) {
        // Usuários ativos sem FK casada (cargo/cidade)
        const orphans = await q(`
            SELECT username,
                   CASE WHEN position_id IS NULL THEN position END AS cargo_sem_match,
                   CASE WHEN city_id IS NULL THEN city END AS cidade_sem_match
              FROM users
             WHERE status = true AND approval_status = 'approved'
               AND auth_provider IN ('INTERNAL','MICROSOFT')
               AND (position_id IS NULL OR city_id IS NULL)`);
        checks.push({
            id: 'db-user-fks', name: 'Usuários com cargo/cidade estruturados',
            status: orphans.length ? 'warn' : 'ok',
            details: orphans.map(o => `${o.username}: ${o.cargo_sem_match ? `cargo "${o.cargo_sem_match}"` : ''} ${o.cidade_sem_match ? `cidade "${o.cidade_sem_match}"` : ''}`.trim()),
            summary: orphans.length ? `${orphans.length} usuário(s) com vínculo por texto sem match` : 'todos casados',
        });

        // Grants apontando para empreendimento inativo/inexistente
        const badGrants = await q(`
            SELECT g.subject_type, g.subject_id, g.enterprise_id
              FROM enterprise_grants g
              LEFT JOIN enterprises e ON e.id = g.enterprise_id
             WHERE e.id IS NULL OR e.active = false`);
        checks.push({
            id: 'db-grants', name: 'Grants íntegros (empreendimentos ativos)',
            status: badGrants.length ? 'warn' : 'ok',
            details: badGrants.map(g => `${g.subject_type} ${g.subject_id} → enterprise ${g.enterprise_id}`),
            summary: badGrants.length ? `${badGrants.length} grant(s) para empreendimento inativo/inexistente` : 'ok',
        });

        // Perfil inativo referenciado por usuário
        const badProfiles = await q(`
            SELECT u.username, p.name AS profile
              FROM users u JOIN permission_profiles p ON p.id = u.permission_profile_id
             WHERE u.status = true AND p.active = false`);
        checks.push({
            id: 'db-profiles', name: 'Perfis vivos ativos',
            status: badProfiles.length ? 'warn' : 'ok',
            details: badProfiles.map(b => `${b.username} → perfil inativo "${b.profile}"`),
            summary: badProfiles.length ? `${badProfiles.length} usuário(s) com perfil inativo` : 'ok',
        });

        // Cobertura de escopo: usuários ativos sem NENHUM grant (nem via perfil)
        const noScope = await q(`
            SELECT u.username FROM users u
             WHERE u.status = true AND u.approval_status = 'approved' AND u.role <> 'admin'
               AND u.auth_provider IN ('INTERNAL','MICROSOFT')
               AND NOT EXISTS (SELECT 1 FROM enterprise_grants g
                    WHERE (g.subject_type='user' AND g.subject_id=u.id)
                       OR (g.subject_type='profile' AND g.subject_id=u.permission_profile_id))`);
        checks.push({
            id: 'db-scope-coverage', name: 'Cobertura de escopo de dados',
            status: 'info',
            details: noScope.map(u => u.username),
            summary: `${noScope.length} usuário(s) ativo(s) sem nenhum empreendimento liberado (não veem dados)`,
        });
    }

    return checks;
}

export async function runIntegrityCheck({ app = _app } = {}) {
    const startedAt = Date.now();
    const checks = [];

    checks.push({
        id: 'config-access-model', name: 'Modelo de acesso ativo',
        status: 'info', details: [],
        summary: 'Grants por empreendimento (modo por cidade removido em 2026-07-29)',
    });

    if (app) checks.push(...await checkRoutes(app));
    if (app) checks.push(...await checkCapabilities(app));
    else checks.push({ id: 'routes', name: 'Varredura de rotas', status: 'warn', details: [], summary: 'app não registrado (registerApp)' });

    checks.push(...await checkEmeTools());
    checks.push(...await checkRoutePolicies());
    checks.push(...await checkDatabase());

    const counts = { ok: 0, warn: 0, fail: 0, info: 0 };
    for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;

    return {
        ranAt: new Date().toISOString(),
        ms: Date.now() - startedAt,
        healthy: counts.fail === 0,
        counts,
        checks,
    };
}

export default { runIntegrityCheck, registerApp, collectRoutes };
