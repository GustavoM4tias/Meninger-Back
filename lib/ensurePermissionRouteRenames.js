// lib/ensurePermissionRouteRenames.js
//
// Migra rotas RENOMEADAS nas alçadas salvas (user_permissions.routes).
// Quando uma tela muda de URL no front (ex.: Viabilidade saiu de
// /financeiro/gastos-departamento para /marketing/viabilidade), as alçadas já
// concedidas apontam para o caminho antigo e o usuário perderia o acesso.
// Este patch reescreve os caminhos antigos para os novos.
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
};

export async function ensurePermissionRouteRenames() {
    const perms = await db.UserPermission.findAll();
    let migrated = 0;

    for (const perm of perms) {
        const routes = Array.isArray(perm.routes) ? perm.routes : [];
        if (!routes.length) continue;

        let changed = false;
        const next = new Set();
        for (const route of routes) {
            const renamed = ROUTE_RENAMES[route];
            if (renamed) {
                next.add(renamed);
                changed = true;
            } else {
                next.add(route);
            }
        }

        if (changed) {
            await perm.update({ routes: [...next] });
            migrated += 1;
        }
    }

    if (migrated) {
        console.log(`✅ [SchemaPatch] Alçadas migradas para rotas renomeadas: ${migrated} usuário(s).`);
    }
}
