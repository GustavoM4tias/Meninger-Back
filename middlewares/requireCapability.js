// middlewares/requireCapability.js
//
// Enforcement de uma AÇÃO dentro da tela, lendo a mesma tabela que o front usa
// para esconder o botão (lib/screenCapabilities.js).
//
// Uso:
//   router.get('/history', authenticate, requireCapability('/financeiro/boleto-caixa', 'view'), h)
//   router.patch('/settings', authenticate, requireCapability('/financeiro/boleto-caixa', 'configure'), h)
//
// Substitui o par "requireRoutePermission na leitura + requireAdmin na
// configuração" por uma declaração só, que diz o que a rota FAZ. Vantagem
// prática: a tela e a API não têm como divergir, porque a regra é a mesma linha
// da tabela.
//
// Regras:
//   - admin: bypass
//   - ação 'screen': exige a tela nas alçadas efetivas
//   - ação 'admin': só administrador
//   - falha de consulta → 403 (fail-closed)
//
// O validador de integridade reconhece este middleware pelos metadados abaixo.

import { userCan } from '../services/permissions/capabilityService.js';
import { capabilitiesOf } from '../lib/screenCapabilities.js';

export default function requireCapability(route, action) {
  const rule = capabilitiesOf(route)[action] || null;

  const mw = async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado.' });
      if (req.user.role === 'admin') return next();
      if (await userCan(req.user, route, action)) return next();
      return res.status(403).json({
        error: rule === 'admin'
          ? 'Esta ação é exclusiva de administradores.'
          : 'Sem alçada para esta ação.',
      });
    } catch (e) {
      console.error('[requireCapability]', e?.message);
      return res.status(403).json({ error: 'Falha ao validar a permissão.' });
    }
  };

  // Metadados para o validador de integridade (security/integrityCheck.js):
  // ação 'screen' conta como alçada de tela; ação 'admin' conta como gate de
  // admin. Sem isto o validador acusaria a rota como desprotegida.
  mw._requiredRoutes = [route];
  mw._capability = { route, action, rule };
  mw._isRoutePermission = rule === 'screen';
  mw._isAdminGate = rule === 'admin';
  return mw;
}
