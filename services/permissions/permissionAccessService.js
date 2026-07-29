// services/permissions/permissionAccessService.js
//
// Fonte ÚNICA das rotas efetivas de alçada de um usuário.
//
//   efetivas = (rotas do perfil vivo ∪ routes_extra) − routes_removed
//                                                    − telas travadas como
//                                                      "somente admin" (route_policies)
//
// Consumidores: middleware requireRoutePermission, /api/permissions/me,
// ToolRegistry (tools da Eme) e a tela de Alçadas. Admin tem bypass nos
// consumidores (não aqui — aqui é só o cálculo).
//
// A subtração das telas travadas mora AQUI de propósito: é o único caminho por
// onde todo enforcement passa, então marcar uma tela como somente-admin na tela
// de Alçadas fecha API, menu, guard de rota e tools da Eme na mesma hora.

import db from '../../models/sequelize/index.js';
import { filterOutAdminOnly } from './routePolicyService.js';

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
  // Telas travadas pelo admin na tela de Alçadas nunca sobram para não-admin,
  // mesmo que continuem listadas no perfil (destravar devolve tudo como estava).
  return filterOutAdminOnly([...set.values()]);
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
