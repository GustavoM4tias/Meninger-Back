// lib/ensurePermissionRouteRetirement.js
//
// APOSENTADORIA de rotas nas alçadas salvas.
//
// Irmão do ensurePermissionRouteRenames: lá a tela mudou de endereço e a alçada
// é reescrita; aqui a tela SUMIU (ou foi decidido que ninguém deve tê-la) e a
// alçada precisa sair de perfis e exceções. Sem isso, rota morta fica boiando
// em perfil e em routes_extra — não concede nada, mas engana quem lê a tela de
// Alçadas e ressuscita se a rota voltar a existir com o mesmo caminho.
//
// Idempotente: roda todo boot e só grava quando encontra algo para tirar.
//
// ATENÇÃO: o conjunto padrão de telas por departamento vive em
// lib/ensureSignupApprovalSchema.js (defaultRoutesForDepartment). Rota
// aposentada aqui e mantida lá volta no boot seguinte para todo perfil com
// routes_customized=false. Os dois arquivos andam juntos.

import db from '../models/sequelize/index.js';

// Rotas que saem de TODA MUNDO (perfis, exceções e o campo legado).
const RETIRED_ROUTES = [
    ['/aprovacoes', 'módulo de Aprovações removido em 2026-08-19'],
    ['/marketing/aprovacoes', 'endereço antigo do módulo de Aprovações'],
    ['/financeiro/paymentflow', 'Fluxo de Pagamento inativo: por decisão não vai para nenhum perfil nem usuário'],
    ['/tools/paymentflow', 'endereço antigo do Fluxo de Pagamento'],
    ['/comercial/distratos', 'tela que não existe mais'],
    ['/microsoft/transcripts', 'virou a aba Reuniões da Central Microsoft'],
    ['/microsoft/inperson', 'nunca foi tela de menu'],
    ['/marketing/viability', 'grafia antiga: a tela é /marketing/viabilidade'],
];

// Rotas que sobrevivem em UM perfil só. Saem de todos os outros perfis e de
// todas as exceções de usuário — quem precisa, recebe pelo perfil.
const EXCLUSIVE_ROUTES = [
    {
        route: '/settings/organograma',
        profile: 'Padrão - Comercial',
        reason: 'Organograma passou a ser alçada, e hoje só o Comercial enxerga (decisão de 2026-08-19)',
    },
];

const norm = (r) => String(r || '').trim().toLowerCase();
const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);

/** Remove as rotas do array (case-insensitive). null = nada mudou. */
function strip(list, removeSet) {
    const current = asArray(list);
    if (!current.length) return null;
    const next = current.filter(r => !removeSet.has(norm(r)));
    return next.length === current.length ? null : next;
}

export async function ensurePermissionRouteRetirement() {
    const retiredSet = new Set(RETIRED_ROUTES.map(([r]) => norm(r)));

    let touchedProfiles = 0;
    let touchedUsers = 0;

    // ── Perfis ────────────────────────────────────────────────────────────────
    const profiles = await db.PermissionProfile.findAll();
    for (const profile of profiles) {
        // Aposentadas saem de qualquer perfil; exclusivas, de todos menos o dono.
        const remove = new Set(retiredSet);
        for (const ex of EXCLUSIVE_ROUTES) {
            if (profile.name !== ex.profile) remove.add(norm(ex.route));
        }
        const next = strip(profile.routes, remove);
        if (next) {
            await profile.update({ routes: next });
            touchedProfiles += 1;
        }
    }

    // ── Usuários (exceções + campo legado) ────────────────────────────────────
    const removeForUsers = new Set(retiredSet);
    for (const ex of EXCLUSIVE_ROUTES) removeForUsers.add(norm(ex.route));

    const perms = await db.UserPermission.findAll();
    for (const perm of perms) {
        const patch = {};
        const extra = strip(perm.routes_extra, removeForUsers);
        const legacy = strip(perm.routes, removeForUsers);
        // routes_removed guarda NEGAÇÕES: só limpa o que virou rota morta, senão
        // uma exclusiva sairia da lista de negados e voltaria a valer pelo perfil.
        const removed = strip(perm.routes_removed, retiredSet);

        if (extra) patch.routes_extra = extra;
        if (legacy) patch.routes = legacy;
        if (removed) patch.routes_removed = removed;

        if (Object.keys(patch).length) {
            await perm.update(patch);
            touchedUsers += 1;
        }
    }

    if (touchedProfiles || touchedUsers) {
        console.log(
            `✅ [SchemaPatch] Rotas aposentadas retiradas das alçadas: `
            + `${touchedProfiles} perfil(is), ${touchedUsers} usuário(s).`
        );
    }
}

export default ensurePermissionRouteRetirement;
