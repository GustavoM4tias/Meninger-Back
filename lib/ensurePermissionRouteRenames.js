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

// caminho antigo → caminho novo (adicionar aqui a cada renome de rota do front).
// Rota que deixou de existir NÃO entra aqui: vai para a lista de aposentadoria
// em lib/ensurePermissionRouteRetirement.js, que a remove das alçadas.
const ROUTE_RENAMES = {
    // 2026-07-28 — Viabilidade (ex "Gastos por Departamento") foi para o Marketing.
    '/financeiro/gastos-departamento': '/marketing/viabilidade',
    // 2026-07-28 — Validador saiu de /tools.
    '/tools/validator': '/validator',
    // 2026-08-05 — Plano de Eventos foi para o Marketing, junto da agenda de
    // Eventos (mesma categoria).
    '/comercial/plano-eventos': '/marketing/plano-eventos',
    // 2026-08-17 — Faturamento e Vendas x Projecao viraram RELATORIOS, cada um
    // com rota propria sob /comercial/relatorios (alcada individual por
    // relatorio). O hub sem relatorio na URL deixou de ser tela.
    '/comercial/faturamento': '/comercial/relatorios/faturamento',
    '/comercial/sales-projection': '/comercial/relatorios/projecao',
    // 2026-08-19 - variação com E maiúsculo gravada antes da normalização. O
    // backend compara sem case, mas o hasAccess() do front compara exato, então
    // a forma canônica é a minúscula (o Set do renameList remove a duplicata).
    '/marketing/Events': '/marketing/events',
    // 2026-08-23 - Boleto Caixa e Link de Cartao viraram UMA tela ("Ato"), sob a
    // subcategoria Cobranca. Sao a mesma coisa do ponto de vista do negocio:
    // cobrar a entrada, mudando so a forma de pagamento. Quem tinha qualquer uma
    // das duas continua com a tela nova.
    '/financeiro/boleto-caixa': '/financeiro/cobranca/ato',
    '/financeiro/link-cartao': '/financeiro/cobranca/ato',
    // 2026-08-24 - os cadastros que vivem no CV (imobiliarias, correspondentes,
    // empreendimentos) sairam de /comercial e viraram a secao CV CRM, junto do
    // painel que configura a integracao. Sem este renome, quem tinha a alcada
    // gravada no caminho antigo perderia as tres telas no primeiro boot.
    '/comercial/imobiliarias': '/crm/imobiliarias',
    '/comercial/correspondentes': '/crm/correspondentes',
    '/comercial/buildings': '/crm/buildings',
    // 2026-08-25 - Grupos de Workflow foi junto: grupo de workflow é situação
    // do CV, e estava em "Condições & Regras" junto de ficha comercial e MCMV,
    // que são regra de produto, não integração.
    '/comercial/workflow/groups': '/crm/workflow/groups',
    // 2026-08-31 - Pre-Cadastros e Reservas viraram guias do Relatorio
    // Comercial. Nas duas "a tela E a listagem", entao sao relatorios como os
    // outros cinco; ficavam num grupo separado do menu e com alcada avulsa.
    '/comercial/precadastros': '/comercial/relatorios/precadastros',
    '/comercial/reservas-report': '/comercial/relatorios/reservas',
    // 2026-08-31 - Backup Sienge e Vendas travadas para o ERP viraram guias da
    // MESMA tela ("Sienge"): as duas olham a mesma integração, uma pelo espelho
    // do banco e a outra pela fila do ERP. Quem tinha qualquer uma das duas
    // continua com a tela nova.
    '/settings/backup-sienge': '/settings/sienge',
    '/settings/envio-sienge': '/settings/sienge',
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
