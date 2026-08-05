// lib/ensurePermissionRouteRenames.js
//
// Migra rotas RENOMEADAS nas alçadas salvas. Quando uma tela muda de URL no
// front, as alçadas já concedidas apontam para o caminho antigo e o usuário
// perderia o acesso. Este patch reescreve os caminhos antigos para os novos em
// TODAS as fontes de rota do modelo "perfil vivo + exceções":
//   - user_permissions.routes (legado), routes_extra, routes_removed
//   - permission_profiles.routes
//
// Idempotente — roda todo boot; só grava quando alguma rota realmente muda e
// nunca duplica (usa Set). Renomes já aplicados viram no-op.

import db from '../models/sequelize/index.js';

// caminho antigo → caminho novo (adicionar aqui a cada renome de rota do front)
const ROUTE_RENAMES = {
    // 2026-07-28 — Viabilidade (ex "Gastos por Departamento") foi para o Marketing.
    '/financeiro/gastos-departamento': '/marketing/viabilidade',
    // 2026-07-28 — Aprovações virou ferramenta geral no topo.
    '/marketing/aprovacoes': '/aprovacoes',
    // 2026-07-28 — Validador saiu de /tools.
    '/tools/validator': '/validator',
    // 2026-08-05 — Plano de Eventos foi para o Marketing, junto da agenda de
    // Eventos (mesma categoria).
    '/comercial/plano-eventos': '/marketing/plano-eventos',
};

function renameList(routes) {
    const list = Array.isArray(routes) ? routes : [];
    if (!list.length) return { changed: false, next: list };
    let changed = false;
    const next = new Set();
    for (const route of list) {
        const renamed = ROUTE_RENAMES[route];
        if (renamed) { next.add(renamed); changed = true; }
        else next.add(route);
    }
    return { changed, next: [...next] };
}

export async function ensurePermissionRouteRenames() {
    let migratedUsers = 0;
    let migratedProfiles = 0;

    const perms = await db.UserPermission.findAll();
    for (const perm of perms) {
        const legacy = renameList(perm.routes);
        const extra = renameList(perm.routes_extra);
        const removed = renameList(perm.routes_removed);
        if (legacy.changed || extra.changed || removed.changed) {
            await perm.update({
                ...(legacy.changed && { routes: legacy.next }),
                ...(extra.changed && { routes_extra: extra.next }),
                ...(removed.changed && { routes_removed: removed.next }),
            });
            migratedUsers += 1;
        }
    }

    const profiles = await db.PermissionProfile.findAll();
    for (const profile of profiles) {
        const r = renameList(profile.routes);
        if (r.changed) {
            await profile.update({ routes: r.next });
            migratedProfiles += 1;
        }
    }

    if (migratedUsers || migratedProfiles) {
        console.log(`✅ [SchemaPatch] Rotas renomeadas migradas: ${migratedUsers} usuário(s), ${migratedProfiles} perfil(is).`);
    }
}
