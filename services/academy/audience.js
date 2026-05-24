// services/academy/audience.js
//
// Helper compartilhado para resolver e aplicar audience.
//
// REGRA: em rotas de aluno (KB list, Community list, Tracks list, Panel, Me),
// audience NÃO vem do query string — vem do role do user no banco. Cliente
// que tenta `?audience=ADM_ONLY` deve ser IGNORADO (defense-in-depth).
//
// Em rotas admin, o admin PODE filtrar por audience via query — mas mesmo
// assim aplicamos a hierarquia inclusiva (ADM_ONLY vê tudo).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

const ALLOWED = ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'];

export function normalizeAudience(v) {
    const a = String(v || '').toUpperCase().trim();
    return ALLOWED.includes(a) ? a : 'BOTH';
}

// Hierarquia inclusiva. ADM_ONLY vê tudo, GESTOR_ONLY vê {BOTH,GESTOR_ONLY},
// BOTH (aluno comum) vê só BOTH.
export function audienceWhere(audience) {
    const a = normalizeAudience(audience);
    if (a === 'ADM_ONLY') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] } };
    if (a === 'GESTOR_ONLY') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY'] } };
    return { audience: 'BOTH' };
}

// Heurística atual para detectar gestor (sem campo dedicado no Position):
// 1) tem subordinados (manager_id de alguém aponta pra ele)
// 2) OU position contém gestor/gerente/diretor/coordenador
async function isManager(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;

    const subs = await db.User.count({ where: { manager_id: user.id, status: true } });
    if (subs > 0) return true;

    const pos = String(user.position || '').toLowerCase();
    return /(gestor|gerente|diretor|coordenador)/.test(pos);
}

// Resolve a audience efetiva a partir do userId. Ignora qualquer hint do cliente.
// Use em rotas de aluno (KB, Community, Tracks, Panel, Me) para fechar o vazamento.
export async function resolveAudienceForUser(userId) {
    if (!userId) return 'BOTH';

    const user = await db.User.findByPk(userId, {
        attributes: ['id', 'role', 'position'],
        raw: true,
    });
    if (!user) return 'BOTH';

    if (user.role === 'admin') return 'ADM_ONLY';
    if (await isManager(user)) return 'GESTOR_ONLY';
    return 'BOTH';
}
