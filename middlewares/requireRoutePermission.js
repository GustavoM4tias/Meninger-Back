// middlewares/requireRoutePermission.js
//
// Enforcement de ALÇADA no backend: a rota de API só responde se o usuário
// tiver (no perfil vivo + exceções) alguma das telas do front que consomem
// este endpoint. Antes deste middleware a alçada era 100% cosmética (o
// backend nunca validava user_permissions).
//
// Uso:
//   router.get('/bills', authenticate, requireRoutePermission('/financeiro/titulos'), handler)
//   router.get('/x', authenticate, requireRoutePermission(['/tela-a', '/tela-b']), handler)
//
// Regras:
//   - admin: bypass
//   - basta UMA das rotas pedidas (endpoint compartilhado entre telas)
//   - falha de consulta → 403 (fail-closed)
//
// O validador de integridade (security/integrityCheck.js) cobra a presença
// deste middleware em toda rota de dados; a allowlist de exceções vive lá.

import { userHasAnyRoute } from '../services/permissions/permissionAccessService.js';

export default function requireRoutePermission(routes) {
  const required = (Array.isArray(routes) ? routes : [routes]).filter(Boolean);

  const mw = async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado.' });
      if (req.user.role === 'admin') return next();
      const ok = await userHasAnyRoute(req.user.id, required);
      if (!ok) return res.status(403).json({ error: 'Sem alçada para acessar estes dados.' });
      return next();
    } catch (e) {
      console.error('[requireRoutePermission]', e?.message);
      return res.status(403).json({ error: 'Falha ao validar alçada.' });
    }
  };
  // Metadado para o validador de integridade reconhecer o middleware no stack.
  mw._requiredRoutes = required;
  mw._isRoutePermission = true;
  return mw;
}
