// services/permissions/permissionAccessService.js
//
// Fonte ÚNICA das rotas efetivas de alçada de um usuário.
//
//   efetivas = (rotas do perfil vivo ∪ routes_extra) − routes_removed
//
// Consumidores: middleware requireRoutePermission, /api/permissions/me,
// ToolRegistry (tools da Eme) e a tela de Alçadas. Admin tem bypass nos
// consumidores (não aqui — aqui é só o cálculo).

import db from '../../models/sequelize/index.js';

function asArray(v) {
  return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
}

/**
 * Rotas efetivas do usuário. Retorna array de strings (paths do front).
 * @param {number} userId
 */
export async function getEffectiveRoutes(userId) {
  if (!userId) return [];
  const [user, perm] = await Promise.all([
    db.User.findByPk(userId, { attributes: ['id', 'permission_profile_id'], raw: true }),
    db.UserPermission.findOne({ where: { userId }, raw: true }),
  ]);
  if (!user) return [];

  let profileRoutes = [];
  if (user.permission_profile_id) {
    const profile = await db.PermissionProfile.findByPk(user.permission_profile_id, {
      attributes: ['routes', 'active'], raw: true,
    });
    if (profile?.active) profileRoutes = asArray(profile.routes);
  }

  const extra = asArray(perm?.routes_extra);
  const removed = new Set(asArray(perm?.routes_removed).map(r => r.toLowerCase()));

  const set = new Map(); // lowercase → forma original
  for (const r of [...profileRoutes, ...extra]) {
    const key = r.toLowerCase();
    if (!removed.has(key)) set.set(key, r);
  }
  return [...set.values()];
}

/**
 * O usuário tem TODAS as rotas pedidas? (case-insensitive)
 * Admin NÃO é tratado aqui — trate no chamador.
 */
export async function userHasRoutes(userId, requiredRoutes = []) {
  if (!requiredRoutes.length) return true;
  const effective = new Set((await getEffectiveRoutes(userId)).map(r => r.toLowerCase()));
  return requiredRoutes.every(r => effective.has(String(r).toLowerCase()));
}

/**
 * O usuário tem ALGUMA das rotas pedidas? Usado pelo middleware de rota de
 * dados (um endpoint pode servir mais de uma tela).
 */
export async function userHasAnyRoute(userId, routes = []) {
  if (!routes.length) return true;
  const effective = new Set((await getEffectiveRoutes(userId)).map(r => r.toLowerCase()));
  return routes.some(r => effective.has(String(r).toLowerCase()));
}

export default { getEffectiveRoutes, userHasRoutes, userHasAnyRoute };
