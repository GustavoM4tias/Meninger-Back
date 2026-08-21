// /controllers/permissionController.js
//
// Alçadas — modelo "perfil vivo + exceções" (2026-07-28):
//   users.permission_profile_id  → perfil aplicado (editar o perfil propaga na hora)
//   user_permissions.routes_extra    → rotas liberadas além do perfil
//   user_permissions.routes_removed  → rotas do perfil negadas ao usuário
//   efetivas = (perfil ∪ extra) − removed   (permissionAccessService)
//
// Grants de DADOS (empreendimentos) ficam em enterprise_grants
// (subject user/profile) — endpoints no fim deste arquivo.

import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import { getEffectiveRoutes, getEffectiveRoutesBulk } from '../services/permissions/permissionAccessService.js';
import {
    getAdminOnlyRoutes, listRoutePolicies, setRoutePolicy, normalizeRoute,
} from '../services/permissions/routePolicyService.js';
import { capabilitiesFor } from '../services/permissions/capabilityService.js';
import { SCREEN_CAPABILITIES } from '../lib/screenCapabilities.js';
import { RETIRED_ROUTES, EXCLUSIVE_ROUTES } from '../lib/ensurePermissionRouteRetirement.js';

// Equipe interna: quem entra pelo login do Office ou pela conta Microsoft.
// Tudo que não é isto é EXTERNO (corretor, imobiliária, correspondente), que
// entra pelo CV. A lista de alçadas mostra os dois desde 2026-08-20 - antes os
// externos simplesmente não existiam para esta tela, e agora eles vão começar a
// acessar. O tipo vai no payload para a tela poder filtrar e rotular.
const EQUIPE_PROVIDERS = ['INTERNAL', 'MICROSOFT'];

// ─── GET /api/permissions/me ─────────────────────────────────────────────────
// Retorna as permissões efetivas do usuário autenticado (mesmo shape de antes:
// o front usa {isAdmin, routes}).
export async function getMyPermissions(req, res) {
    try {
        // adminOnlyRoutes: telas travadas como somente-admin na tela de Alçadas.
        // Vai para todo mundo porque o front precisa esconder no menu e barrar no
        // guard de rota — as rotas efetivas abaixo já vêm sem elas.
        const adminOnlyRoutes = [...await getAdminOnlyRoutes()];
        // capabilities: o que o usuário pode FAZER dentro de cada tela
        // (lib/screenCapabilities.js). Vai calculado do servidor de propósito —
        // o front só consulta, então não tem como se conceder ação nenhuma.
        const capabilities = await capabilitiesFor(req.user);
        if (req.user.role === 'admin') {
            return res.json({ isAdmin: true, routes: null, adminOnlyRoutes, capabilities });
        }
        const routes = await getEffectiveRoutes(req.user.id);
        return res.json({ isAdmin: false, routes, adminOnlyRoutes, capabilities });
    } catch (err) {
        console.error('[Permissions] getMyPermissions error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── GET /api/permissions ────────────────────────────────────────────────────
// Lista usuários ativos com perfil, exceções e rotas efetivas. (admin only)
export async function getAllPermissions(req, res) {
    try {
        const users = await db.User.findAll({
            where: { status: true },
            attributes: [
                'id', 'username', 'email', 'role', 'status', 'permission_profile_id',
                'auth_provider', 'external_kind', 'external_organization_id',
            ],
            include: [{
                model: db.UserPermission,
                as: 'permission',
                required: false,
                attributes: ['routes', 'routes_extra', 'routes_removed', 'updatedAt'],
            }],
            order: [['username', 'ASC']],
        });

        // Rotas efetivas em LOTE. Era um getEffectiveRoutes por usuario dentro do
        // laco: 3 consultas x N usuarios, ~7s com 28 pessoas. O calculo e o
        // mesmo; o que muda e a ida ao banco.
        const naoAdmins = users.filter(u => u.role !== 'admin');
        const efetivas = await getEffectiveRoutesBulk(
            naoAdmins.map(u => u.id),
            {
                // ja vieram no SELECT acima - nao vale outra viagem ao banco
                users: naoAdmins.map(u => ({ id: u.id, permission_profile_id: u.permission_profile_id })),
                perms: naoAdmins
                    .filter(u => u.permission)
                    .map(u => ({
                        userId: u.id,
                        routes_extra: u.permission.routes_extra,
                        routes_removed: u.permission.routes_removed,
                    })),
            },
        );

        const out = users.map(u => {
            const plain = u.toJSON();
            plain.effectiveRoutes = plain.role === 'admin' ? null : (efetivas.get(plain.id) || []);
            // `tipo` resolvido aqui para a tela não repetir a regra: é o mesmo
            // corte que separa quem é da casa de quem vem do CV.
            plain.tipo = EQUIPE_PROVIDERS.includes(plain.auth_provider) ? 'equipe' : 'externo';
            return plain;
        });
        return res.json(out);
    } catch (err) {
        console.error('[Permissions] getAllPermissions error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── PUT /api/permissions/:userId ────────────────────────────────────────────
// Define perfil + exceções de um usuário. (admin only)
// Body novo: { profileId, routesExtra, routesRemoved }
// Body legado: { routes } → vira routesExtra (sem perfil), routesRemoved=[].
export async function setUserPermissions(req, res) {
    try {
        const { userId } = req.params;
        const body = req.body || {};

        const user = await db.User.findByPk(userId, { attributes: ['id', 'role', 'username'] });
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });

        if (user.role === 'admin') {
            return res.status(400).json({ message: 'Administradores têm acesso total por padrão. Não é possível editar suas permissões.' });
        }

        let { profileId, routesExtra, routesRemoved } = body;
        if (Array.isArray(body.routes) && routesExtra === undefined) {
            // chamada legada (substituição total) — vira exceções puras
            routesExtra = body.routes;
            routesRemoved = [];
        }
        const clean = (v) => Array.isArray(v) ? [...new Set(v.filter(Boolean).map(String))] : undefined;
        routesExtra = clean(routesExtra);
        routesRemoved = clean(routesRemoved);

        if (profileId !== undefined) {
            let pid = profileId ? Number(profileId) : null;
            if (pid) {
                const profile = await db.PermissionProfile.findByPk(pid, { attributes: ['id', 'active'] });
                if (!profile || !profile.active) return res.status(400).json({ message: 'Perfil inválido ou inativo.' });
            }
            await db.User.update({ permission_profile_id: pid }, { where: { id: user.id } });
        }

        if (routesExtra !== undefined || routesRemoved !== undefined) {
            const [perm] = await db.UserPermission.findOrCreate({
                where: { userId: user.id },
                defaults: { userId: user.id, routes: [], routes_extra: [], routes_removed: [], routes_migrated: true },
            });
            await perm.update({
                ...(routesExtra !== undefined && { routes_extra: routesExtra }),
                ...(routesRemoved !== undefined && { routes_removed: routesRemoved }),
                routes_migrated: true,
            });
        }

        return res.json({ success: true, message: `Permissões de ${user.username} atualizadas.` });
    } catch (err) {
        console.error('[Permissions] setUserPermissions error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── Políticas de tela (somente admin, sem deploy) ───────────────────────────
//
// GET  /api/permissions/route-policies        → lista das telas travadas
// PUT  /api/permissions/route-policies        { route, adminOnly, note? }
//
// Travar aqui remove a tela das alçadas efetivas de TODO não-admin na hora
// (permissionAccessService), o que fecha API, menu, guard e tools da Eme.
// Só telas delegáveis chegam aqui: as exclusivas por código já são barradas
// pelo requireAdmin das próprias rotas de API.

const ROUTE_RE = /^\/[a-z0-9][a-z0-9\-_/]{0,198}$/i;

export async function getRoutePolicies(req, res) {
    try {
        return res.json({ policies: await listRoutePolicies() });
    } catch (err) {
        console.error('[Permissions] getRoutePolicies error:', err);
        return res.status(500).json({ message: err.message });
    }
}

export async function putRoutePolicy(req, res) {
    try {
        const route = normalizeRoute(req.body?.route);
        const adminOnly = req.body?.adminOnly === true || req.body?.adminOnly === 'true';
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;

        if (!ROUTE_RE.test(route)) {
            return res.status(400).json({ message: 'Rota inválida.' });
        }
        const result = await setRoutePolicy({ route, adminOnly, note, userId: req.user?.id || null });
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('[Permissions] putRoutePolicy error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── Grants de empreendimento (dados) ────────────────────────────────────────

function parseSubject(req) {
    const type = String(req.params.subjectType || '').toLowerCase();
    const id = Number(req.params.subjectId);
    if (!['user', 'profile'].includes(type) || !Number.isFinite(id) || id <= 0) return null;
    return { type, id };
}

// GET /api/permissions/grants/:subjectType/:subjectId → { enterpriseIds }
export async function getGrants(req, res) {
    try {
        const s = parseSubject(req);
        if (!s) return res.status(400).json({ message: 'Sujeito inválido (user|profile + id).' });
        const rows = await db.EnterpriseGrant.findAll({
            where: { subject_type: s.type, subject_id: s.id },
            attributes: ['enterprise_id'],
            raw: true,
        });
        return res.json({ enterpriseIds: rows.map(r => Number(r.enterprise_id)) });
    } catch (err) {
        console.error('[Permissions] getGrants error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// PUT /api/permissions/grants/:subjectType/:subjectId { enterpriseIds: [] }
// Substitui o conjunto (a tela manda o estado final; atalhos empresa/cidade
// são expandidos no front para ids explícitos).
export async function setGrants(req, res) {
    try {
        const s = parseSubject(req);
        if (!s) return res.status(400).json({ message: 'Sujeito inválido (user|profile + id).' });
        const ids = [...new Set((req.body?.enterpriseIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0))];

        if (s.type === 'user') {
            const user = await db.User.findByPk(s.id, { attributes: ['id', 'role'] });
            if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
            if (user.role === 'admin') return res.status(400).json({ message: 'Administradores enxergam tudo por padrão.' });
        } else {
            const profile = await db.PermissionProfile.findByPk(s.id, { attributes: ['id'] });
            if (!profile) return res.status(404).json({ message: 'Perfil não encontrado.' });
        }

        // valida que os ids existem (evita grant fantasma)
        const valid = await db.OrgEnterprise.findAll({ where: { id: ids }, attributes: ['id'], raw: true });
        const validSet = new Set(valid.map(v => Number(v.id)));
        const finalIds = ids.filter(id => validSet.has(id));

        await db.sequelize.transaction(async (t) => {
            await db.EnterpriseGrant.destroy({ where: { subject_type: s.type, subject_id: s.id }, transaction: t });
            if (finalIds.length) {
                await db.EnterpriseGrant.bulkCreate(
                    finalIds.map(eid => ({
                        subject_type: s.type, subject_id: s.id,
                        enterprise_id: eid, granted_by: req.user?.id || null,
                    })),
                    { transaction: t }
                );
            }
        });

        return res.json({ success: true, count: finalIds.length });
    } catch (err) {
        console.error('[Permissions] setGrants error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// `enterprises.city` é texto livre vindo do CV e do Sienge, então a mesma cidade
// chega escrita de mais de um jeito ("Marilia" e "Marília", "Sao Paulo" e "São
// Paulo"). Na tela isso virava DUAS entradas de cidade, cada uma com parte dos
// empreendimentos - quem liberasse por uma delas deixava a outra metade de fora.
//
// A chave normalizada agrupa; o rótulo bonito vem do catálogo de municípios
// (user_cities, semeado do IBGE) quando a cidade existe lá. Nada é reescrito no
// banco: isto é leitura, e a limpeza do cadastro é decisão de quem administra.
const chaveCidade = (c) => String(c || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

async function rotulosDeCidade(cidadesCruas) {
    const chaves = [...new Set(cidadesCruas.map(chaveCidade).filter(Boolean))];
    if (!chaves.length) return new Map();

    // Uma consulta só: o catálogo tem 5.297 municípios e a lista de cidades em
    // uso tem dezenas - cruzar linha a linha seria varredura à toa.
    const rows = await db.sequelize.query(
        `SELECT name, uf, unaccent(upper(TRIM(name))) AS chave
           FROM user_cities
          WHERE active = true AND unaccent(upper(TRIM(name))) IN (:chaves)`,
        { replacements: { chaves }, type: db.Sequelize.QueryTypes.SELECT },
    );

    const oficial = new Map();
    for (const r of rows) if (!oficial.has(r.chave)) oficial.set(r.chave, r.name);

    // Sem município correspondente (distrito, ou erro de digitação no cadastro),
    // vence a grafia mais repetida entre as que chegaram.
    const frequencia = new Map();
    for (const c of cidadesCruas) {
        const k = chaveCidade(c);
        if (!k) continue;
        const porGrafia = frequencia.get(k) || new Map();
        const g = String(c).trim();
        porGrafia.set(g, (porGrafia.get(g) || 0) + 1);
        frequencia.set(k, porGrafia);
    }

    const out = new Map();
    for (const k of chaves) {
        if (oficial.has(k)) { out.set(k, oficial.get(k)); continue; }
        const porGrafia = frequencia.get(k) || new Map();
        const melhor = [...porGrafia.entries()].sort((a, b) => b[1] - a[1])[0];
        out.set(k, melhor ? melhor[0] : k);
    }
    return out;
}

// GET /api/permissions/enterprise-options — árvore Empresa → Empreendimentos
// para a tela de Alçadas (admin only). Devolve a cidade normalizada (chave +
// rótulo) para a tela agrupar sem depender da grafia.
export async function getEnterpriseOptions(req, res) {
    try {
        const rows = await db.OrgEnterprise.findAll({
            where: { active: true },
            attributes: ['id', 'name', 'city', 'uf', 'pair_status', 'company_id'],
            include: [{ model: db.OrgCompany, as: 'company', attributes: ['id', 'name'] }],
            order: [['name', 'ASC']],
        });

        const rotulos = await rotulosDeCidade(rows.map(r => r.city));

        return res.json(rows.map(r => {
            const chave = chaveCidade(r.city);
            return {
                id: r.id,
                name: r.name,
                city: r.city,
                // cityKey agrupa; cityLabel é o que se mostra
                cityKey: chave || null,
                cityLabel: chave ? (rotulos.get(chave) || String(r.city).trim()) : null,
                uf: r.uf,
                pairStatus: r.pair_status,
                companyId: r.company_id,
                companyName: r.company?.name || null,
            };
        }));
    } catch (err) {
        console.error('[Permissions] getEnterpriseOptions error:', err);
        return res.status(500).json({ message: err.message });
    }
}


// ─── GET /api/permissions/capabilities ───────────────────────────────────────
// Catalogo de ACOES por tela (lib/screenCapabilities.js). Ate aqui a regra so
// saia do backend ja resolvida para UM usuario (/me); a tela de Alcadas nao
// tinha como mostrar QUE acoes existem, e por isso continuava binaria
// (tem/nao tem a tela) enquanto a API ja raciocinava por acao. (admin only)
export async function getCapabilityCatalog(_req, res) {
    try {
        const screens = Object.entries(SCREEN_CAPABILITIES).map(([route, actions]) => ({
            route,
            actions: Object.entries(actions).map(([action, rule]) => ({ action, rule })),
            // atalhos para a tela nao precisar recalcular
            delegableActions: Object.entries(actions).filter(([, r]) => r === 'screen').map(([a]) => a),
            adminActions: Object.entries(actions).filter(([, r]) => r === 'admin').map(([a]) => a),
        })).sort((a, b) => a.route.localeCompare(b.route));

        return res.json({
            screens,
            totalScreens: screens.length,
            totalActions: screens.reduce((acc, s) => acc + s.actions.length, 0),
        });
    } catch (err) {
        console.error('[Permissions] getCapabilityCatalog error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── GET /api/permissions/grants ─────────────────────────────────────────────
// TODOS os grants de uma vez, agrupados por sujeito. O endpoint por sujeito
// continua existindo para o modal; este existe para a tela conseguir responder
// "quem esta sem liberacao de dados" sem uma chamada por pessoa. (admin only)
export async function getGrantsBulk(_req, res) {
    try {
        const rows = await db.EnterpriseGrant.findAll({
            attributes: ['subject_type', 'subject_id', 'enterprise_id'], raw: true,
        });
        const user = {};
        const profile = {};
        for (const r of rows) {
            const alvo = r.subject_type === 'profile' ? profile : user;
            const key = String(r.subject_id);
            (alvo[key] ||= []).push(Number(r.enterprise_id));
        }
        return res.json({ user, profile });
    } catch (err) {
        console.error('[Permissions] getGrantsBulk error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── GET /api/permissions/retired-routes ─────────────────────────────────────
// Rotas que o boot tira de perfis e excecoes (ensurePermissionRouteRetirement).
// A tela precisa disso para explicar por que uma alcada "sumiu sozinha" - sem
// a lista, o admin religa a rota e ela some de novo no boot seguinte.
// (admin only)
export async function getRetiredRoutes(_req, res) {
    try {
        return res.json({
            retired: RETIRED_ROUTES.map(([route, reason]) => ({ route, reason })),
            exclusive: EXCLUSIVE_ROUTES.map(e => ({ route: e.route, profile: e.profile, reason: e.reason })),
        });
    } catch (err) {
        console.error('[Permissions] getRetiredRoutes error:', err);
        return res.status(500).json({ message: err.message });
    }
}
