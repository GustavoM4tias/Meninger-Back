// services/academy/audience.js
//
// Modelo de visibilidade do Academy — versão MULTI-AUDIENCE.
//
// ┌────────────────────────────────────────────────────────────────────┐
// │ Cada artefato (artigo, trilha, tópico, highlight) carrega um SET   │
// │ de tokens de público — coluna `audiences` (JSONB array de strings).│
// │                                                                    │
// │ Cada usuário resolve um SET de tokens com base em quem ele é:      │
// │   - admin                → todos os tokens (vê tudo)               │
// │   - interno gestor       → ['INTERNAL','GESTOR']                   │
// │   - interno comum        → ['INTERNAL']                            │
// │   - corretor externo     → ['BROKER']                              │
// │   - imobiliária externa  → ['REALESTATE']                          │
// │   - correspondente ext.  → ['CORRESPONDENT']                       │
// │                                                                    │
// │ Visibilidade = INTERSEÇÃO não-vazia entre os tokens do usuário     │
// │ e o `audiences` do artefato. No Postgres: `audiences ?| ARRAY[...]`│
// └────────────────────────────────────────────────────────────────────┘
//
// REGRA: rotas de aluno NUNCA aceitam tokens vindos do cliente — sempre
// recalculadas server-side a partir do `userId` autenticado.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

// Todos os tokens reconhecidos pelo sistema. Ordem é a usada na UI.
export const TOKEN_VALUES = ['INTERNAL', 'GESTOR', 'BROKER', 'REALESTATE', 'CORRESPONDENT', 'ADMIN'];

export const TOKEN_LABELS = {
    INTERNAL: 'Funcionários Menin',
    GESTOR: 'Gestores',
    ADMIN: 'Apenas administradores',
    BROKER: 'Corretores',
    REALESTATE: 'Imobiliárias',
    CORRESPONDENT: 'Correspondentes',
};

// ── Compat com o modelo legacy (audience enum) ───────────────────────
const ALLOWED_LEGACY = ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'];

export function normalizeAudience(v) {
    const a = String(v || '').toUpperCase().trim();
    return ALLOWED_LEGACY.includes(a) ? a : 'BOTH';
}

// Filtro legacy — ainda exportado para callers antigos enquanto migramos.
// Use `audiencesWhereLiteral` para os filtros novos.
export function audienceWhere(audience) {
    const a = normalizeAudience(audience);
    if (a === 'ADM_ONLY') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY', 'ADM_ONLY'] } };
    if (a === 'GESTOR_ONLY') return { audience: { [Op.in]: ['BOTH', 'GESTOR_ONLY'] } };
    return { audience: 'BOTH' };
}

// ── Detecta gestor (mantida do modelo antigo) ────────────────────────
async function isManager(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;

    const subs = await db.User.count({ where: { manager_id: user.id, status: true } });
    if (subs > 0) return true;

    const pos = String(user.position || '').toLowerCase();
    return /(gestor|gerente|diretor|coordenador)/.test(pos);
}

// Helper legacy — ainda exportado para callers antigos.
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

// ──────────────────────────────────────────────────────────────────────
// MODELO NOVO: tokens por usuário + filtro JSONB
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a lista de tokens (público) de um usuário.
 * É a única fonte de verdade do que ele pode enxergar.
 */
export async function resolveUserTokens(userId) {
    // Não autenticado: nada (defensivo — rotas normalmente exigem auth antes).
    if (!userId) return [];

    const user = await db.User.findByPk(userId, {
        attributes: ['id', 'role', 'position', 'auth_provider', 'external_kind'],
        raw: true,
    });
    if (!user) return [];

    // Admin vê tudo — incluindo conteúdo restrito a qualquer outro perfil.
    if (user.role === 'admin') return TOKEN_VALUES.slice();

    const provider = String(user.auth_provider || 'INTERNAL').toUpperCase();
    const kind = String(user.external_kind || '').toUpperCase();
    const isExternal = provider === 'CVCRM' || !!kind;

    if (isExternal) {
        // Externos veem APENAS o conteúdo do tipo deles. Sem fallback.
        if (kind === 'BROKER') return ['BROKER'];
        if (kind === 'REALESTATE') return ['REALESTATE'];
        if (kind === 'CORRESPONDENT') return ['CORRESPONDENT'];
        return []; // externo de tipo desconhecido → não vê nada
    }

    // Interno Office.
    const tokens = ['INTERNAL'];
    if (await isManager(user)) tokens.push('GESTOR');
    return tokens;
}

/**
 * Normaliza um array recebido do cliente em um set válido de tokens.
 * Descarta valores desconhecidos. Mantém a ordem canônica de TOKEN_VALUES.
 */
export function normalizeAudiences(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    for (const item of input) {
        const t = String(item || '').toUpperCase().trim();
        if (TOKEN_VALUES.includes(t)) seen.add(t);
    }
    return TOKEN_VALUES.filter((t) => seen.has(t));
}

/**
 * Constrói o where-clause Sequelize (literal) que filtra registros visíveis
 * para um conjunto de tokens do usuário usando o operador JSONB `?|`.
 *
 * `columnName` permite reusar em joins/raw queries.
 *
 * Importante: se `tokens` é vazio, retorna `FALSE` — usuário não vê nada.
 * Defesa em profundidade: melhor cego do que vazar.
 */
export function audiencesWhereLiteral(tokens, columnName = 'audiences') {
    if (!Array.isArray(tokens) || !tokens.length) {
        return db.Sequelize.literal('FALSE');
    }
    // Sanitiza: só permite valores conhecidos para evitar SQL injection pelo nome.
    const safe = tokens
        .filter((t) => TOKEN_VALUES.includes(t))
        .map((t) => `'${t}'`)
        .join(',');
    if (!safe) return db.Sequelize.literal('FALSE');
    // O nome da coluna é controlado por nós (callers passam string fixa), mas
    // sanitizamos por garantia.
    const col = String(columnName).replace(/[^a-zA-Z0-9_."]/g, '');
    return db.Sequelize.literal(`${col} ?| ARRAY[${safe}]`);
}

/**
 * Atalho: a partir do userId, devolve {tokens, whereLiteral} prontos pra usar
 * dentro de qualquer service que liste artefatos.
 */
export async function whereForUser(userId, columnName = 'audiences') {
    const tokens = await resolveUserTokens(userId);
    return {
        tokens,
        where: audiencesWhereLiteral(tokens, columnName),
    };
}

/**
 * Deriva um `audience` enum legacy a partir de uma lista de tokens — útil
 * apenas para preencher a coluna legacy `audience` quando salvamos.
 *   set vazio                                    → BOTH (defensivo)
 *   contém ADMIN sem o resto                     → ADM_ONLY
 *   contém GESTOR sem INTERNAL/externos          → GESTOR_ONLY
 *   qualquer combinação com tokens "amplos"      → BOTH
 */
export function deriveLegacyAudience(audiences) {
    const a = normalizeAudiences(audiences);
    if (!a.length) return 'BOTH';
    if (a.length === 1 && a[0] === 'ADMIN') return 'ADM_ONLY';
    if (a.length === 1 && a[0] === 'GESTOR') return 'GESTOR_ONLY';
    return 'BOTH';
}

// ── Para writes: o admin define audiences manualmente; se não informou,
// assumimos "todo mundo, exceto admin-only" como padrão seguro de inclusão.
export const DEFAULT_AUDIENCES = ['INTERNAL', 'GESTOR', 'BROKER', 'REALESTATE', 'CORRESPONDENT'];
