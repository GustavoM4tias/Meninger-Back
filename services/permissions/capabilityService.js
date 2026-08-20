// services/permissions/capabilityService.js
//
// Resolve as CAPACIDADES (ações dentro da tela) de um usuário a partir da
// tabela em lib/screenCapabilities.js.
//
// Regra por ação:
//   'screen' → o usuário tem a tela nas alçadas efetivas (admin sempre tem)
//   'admin'  → o usuário é administrador
//
// Fail-closed: ação não declarada é negada para não-admin.

import { SCREEN_CAPABILITIES, capabilitiesOf } from '../../lib/screenCapabilities.js';
import { getEffectiveRoutes } from './permissionAccessService.js';

const norm = (r) => String(r || '').trim().toLowerCase();

function allow(rule, { isAdmin, hasScreen }) {
    if (isAdmin) return true;
    if (rule === 'admin') return false;
    if (rule === 'screen') return hasScreen;
    return false; // regra desconhecida: nega
}

/**
 * Mapa { rota: [ações permitidas] } para o usuário.
 * Vai inteiro para o front no /api/permissions/me — o front só consulta.
 */
export async function capabilitiesFor(user) {
    const isAdmin = user?.role === 'admin';
    const routes = new Set(
        isAdmin ? [] : (await getEffectiveRoutes(user?.id)).map(norm)
    );

    const out = {};
    for (const [route, actions] of Object.entries(SCREEN_CAPABILITIES)) {
        const hasScreen = isAdmin || routes.has(norm(route));
        const granted = Object.entries(actions)
            .filter(([, rule]) => allow(rule, { isAdmin, hasScreen }))
            .map(([action]) => action);
        if (granted.length) out[route] = granted;
    }
    return out;
}

/**
 * O usuário pode UMA ação específica? Usado pelo middleware — não monta o mapa
 * inteiro à toa em toda request.
 */
export async function userCan(user, route, action) {
    const rule = capabilitiesOf(route)[action];
    if (!rule) return user?.role === 'admin'; // ação não declarada: só admin
    if (user?.role === 'admin') return true;
    if (rule === 'admin') return false;
    if (rule !== 'screen') return false;
    const routes = (await getEffectiveRoutes(user?.id)).map(norm);
    return routes.includes(norm(route));
}

export default { capabilitiesFor, userCan };
