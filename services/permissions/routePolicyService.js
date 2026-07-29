// services/permissions/routePolicyService.js
//
// Telas marcadas como EXCLUSIVAS DE ADMIN pela própria tela de Alçadas
// (tabela route_policies). É a versão "sem deploy" do adminOnly do código.
//
// Ponto único de leitura: permissionAccessService remove essas rotas das
// alçadas efetivas, e como TODO enforcement passa por lá
// (requireRoutePermission, /api/permissions/me, ToolRegistry da Eme), travar
// aqui fecha menu, guard de rota, API e IA de uma vez só.
//
// Cache em memória (TTL curto + invalidação na escrita): a checagem entra em
// toda request de dados; ler o banco toda vez seria caro à toa.

import db from '../../models/sequelize/index.js';

const TTL_MS = 30_000;

let cache = { at: 0, routes: new Set(), primed: false };

/** Normaliza o caminho da tela (minúsculas, sem barra final). */
export function normalizeRoute(route) {
    const r = String(route || '').trim().toLowerCase().replace(/\/+$/, '');
    return r || '/';
}

export function invalidateRoutePolicyCache() {
    cache = { at: 0, routes: new Set(), primed: false };
}

/**
 * Conjunto (normalizado) das rotas travadas como somente-admin.
 * Falha de leitura: mantém o último conjunto conhecido e loga — o gate
 * principal (rotas do perfil) continua valendo, então derrubar tudo por um
 * erro transitório de banco seria pior que manter a última foto.
 */
export async function getAdminOnlyRoutes() {
    if (cache.primed && Date.now() - cache.at < TTL_MS) return cache.routes;
    try {
        const rows = await db.RoutePolicy.findAll({
            where: { admin_only: true }, attributes: ['route'], raw: true,
        });
        cache = { at: Date.now(), routes: new Set(rows.map(r => normalizeRoute(r.route))), primed: true };
    } catch (err) {
        console.warn('[routePolicy] falha ao ler route_policies:', err?.message);
    }
    return cache.routes;
}

/** A tela está travada? Cobre sub-rotas (/tela/123 herda de /tela). */
export async function isRouteAdminOnly(route) {
    const locked = await getAdminOnlyRoutes();
    if (!locked.size) return false;
    const path = normalizeRoute(route);
    for (const r of locked) {
        if (path === r || path.startsWith(r + '/')) return true;
    }
    return false;
}

/** Remove das alçadas as telas travadas (usado no cálculo das rotas efetivas). */
export async function filterOutAdminOnly(routes = []) {
    const locked = await getAdminOnlyRoutes();
    if (!locked.size) return routes;
    return routes.filter(r => !locked.has(normalizeRoute(r)));
}

/** Lista completa das políticas (tela de Alçadas / validador). */
export async function listRoutePolicies() {
    const rows = await db.RoutePolicy.findAll({
        include: [{ model: db.User, as: 'updater', attributes: ['id', 'username'], required: false }],
        order: [['route', 'ASC']],
    });
    return rows.map(r => ({
        route: r.route,
        adminOnly: !!r.admin_only,
        note: r.note || null,
        updatedAt: r.updatedAt,
        updatedBy: r.updater?.username || null,
    }));
}

/**
 * Trava/destrava uma tela. adminOnly=false APAGA a linha (volta ao padrão do
 * código: delegável pelas Alçadas), em vez de guardar uma exceção "liberada"
 * que ninguém saberia interpretar depois.
 */
export async function setRoutePolicy({ route, adminOnly, note = null, userId = null }) {
    const path = normalizeRoute(route);
    if (!adminOnly) {
        await db.RoutePolicy.destroy({ where: { route: path } });
        invalidateRoutePolicyCache();
        return { route: path, adminOnly: false };
    }
    const [row, created] = await db.RoutePolicy.findOrCreate({
        where: { route: path },
        defaults: { route: path, admin_only: true, note, updated_by: userId },
    });
    if (!created) await row.update({ admin_only: true, note, updated_by: userId });
    invalidateRoutePolicyCache();
    return { route: path, adminOnly: true };
}

export default {
    normalizeRoute, getAdminOnlyRoutes, isRouteAdminOnly, filterOutAdminOnly,
    listRoutePolicies, setRoutePolicy, invalidateRoutePolicyCache,
};
