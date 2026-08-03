// security/integrityCheck.js
//
// VALIDADOR DE INTEGRIDADE DE SEGURANÇA.
//
// Varre o app Express em execução e o banco, conferindo que o padrão de
// acesso (spec em _estudo/acessos/README.md) está sendo cumprido:
//
//   1. Toda rota /api/* tem autenticação (exceto allowlist pública explícita).
//   2. Rotas /api/admin/* têm requireAdmin (exceto allowlist).
//   3. Rotas de DADOS têm requireRoutePermission ou requireAdmin (exceto allowlist).
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

let _app = null;
export function registerApp(app) { _app = app; }

// ── Allowlists (cada entrada precisa de motivo) ──────────────────────────────

// Prefixos de rota que PODEM ficar sem autenticação:
const PUBLIC_PREFIXES = [
    '/api/auth',                 // login/refresh/reset — é o próprio fluxo de autenticação
    '/api/microsoft',            // OAuth redirect da Microsoft
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
    '/api/meta-app-oauth',       // callback OAuth Meta (state assinado no controller)
    '/api/ai/validator',         // job server-to-server (protegido por token interno — security/internalJobToken)
    '/api/cv/banners',           // banners exibidos na TELA DE LOGIN (pré-autenticação; sem dado de negócio)
];

// Rotas de dados que por decisão NÃO têm alçada de tela (motivo ao lado):
const DATA_ALLOWLIST = [
    '/api/sienge/contracts/sync/status', // status de sync, sem dado de negócio
    '/api/cv/banners',                   // banners de campanha exibidos na home
    '/api/mcmv/ai-query',                // consumida pela Eme (function calling), tabela pública MCMV
    '/api/event-plans/settings',         // admin-only no controller (config do Plano de Eventos)
    '/api/event-plans/auth-profiles',    // admin-only no controller (perfis de alçada)
    '/api/event-plans/permissions',      // devolve só o que o PRÓPRIO solicitante pode fazer
    '/api/event-plans/users',            // admin-only no controller (monta os perfis de alçada)
];

// Prefixos que são DADOS de negócio e exigem requireRoutePermission/requireAdmin:
const DATA_PREFIXES = [
    '/api/expenses', '/api/sienge', '/api/cv', '/api/conditions',
    '/api/projections', '/api/dept-spending', '/api/events',
    '/api/checklists', '/api/sales-stands', '/api/bucket-upload',
    '/api/realestate', '/api/ai', '/api/org',
    '/api/correspondents', '/api/event-plans',
];

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
        ((m.name === 'requireAdmin' || m.name === 'adminOnly') && (!m.viaUse || r.path.startsWith(m.usePrefix || ''))));
}
function hasRoutePermission(r) {
    return r.middlewares.some(m =>
        (m.isRoutePermission && (!m.viaUse || r.path.startsWith(m.usePrefix || ''))));
}
function inList(path, list) {
    return list.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p));
}

// ── Checks ───────────────────────────────────────────────────────────────────

async function checkRoutes(app) {
    const routes = collectRoutes(app).filter(r => r.path.startsWith('/api'));
    const noAuth = [];
    const adminExposed = [];
    const dataNoPermission = [];

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

        if (inList(r.path, DATA_PREFIXES) && !inList(r.path, DATA_ALLOWLIST)) {
            if (!hasRoutePermission(r) && !hasAdmin(r)) dataNoPermission.push(key);
        }
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
            status: dataNoPermission.length ? 'fail' : 'ok',
            details: dataNoPermission,
            summary: dataNoPermission.length ? `${dataNoPermission.length} rota(s) de dados sem alçada` : 'todas as rotas de dados com alçada',
        },
    ];
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
