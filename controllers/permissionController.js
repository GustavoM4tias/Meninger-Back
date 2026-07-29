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
import { getEffectiveRoutes } from '../services/permissions/permissionAccessService.js';

// Apenas usuários do Office (não Academy/CVCRM)
const OFFICE_PROVIDERS = ['INTERNAL', 'MICROSOFT'];

// ─── GET /api/permissions/me ─────────────────────────────────────────────────
// Retorna as permissões efetivas do usuário autenticado (mesmo shape de antes:
// o front usa {isAdmin, routes}).
export async function getMyPermissions(req, res) {
    try {
        if (req.user.role === 'admin') {
            return res.json({ isAdmin: true, routes: null });
        }
        const routes = await getEffectiveRoutes(req.user.id);
        return res.json({ isAdmin: false, routes });
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
            where: {
                status: true,
                auth_provider: { [Op.in]: OFFICE_PROVIDERS },
            },
            attributes: ['id', 'username', 'email', 'role', 'status', 'permission_profile_id'],
            include: [{
                model: db.UserPermission,
                as: 'permission',
                required: false,
                attributes: ['routes', 'routes_extra', 'routes_removed', 'updatedAt'],
            }],
            order: [['username', 'ASC']],
        });

        const out = [];
        for (const u of users) {
            const plain = u.toJSON();
            plain.effectiveRoutes = plain.role === 'admin' ? null : await getEffectiveRoutes(plain.id);
            out.push(plain);
        }
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

// GET /api/permissions/enterprise-options — árvore Empresa → Empreendimentos
// para a tela de Alçadas (admin only). Inclui cidade para o atalho "cidade inteira".
export async function getEnterpriseOptions(req, res) {
    try {
        const rows = await db.OrgEnterprise.findAll({
            where: { active: true },
            attributes: ['id', 'name', 'city', 'uf', 'pair_status', 'company_id'],
            include: [{ model: db.OrgCompany, as: 'company', attributes: ['id', 'name'] }],
            order: [['name', 'ASC']],
        });
        return res.json(rows.map(r => ({
            id: r.id,
            name: r.name,
            city: r.city,
            uf: r.uf,
            pairStatus: r.pair_status,
            companyId: r.company_id,
            companyName: r.company?.name || null,
        })));
    } catch (err) {
        console.error('[Permissions] getEnterpriseOptions error:', err);
        return res.status(500).json({ message: err.message });
    }
}
