// services/academy/departmentVisibility.js
//
// Visibilidade por DEPARTAMENTO (modelo interno do Office, 2026-06).
//
// Substitui, no editor, a antiga "audiência" (interno/externo). Cada artigo e
// trilha carrega um SET de departamentos — coluna `department_ids` (JSONB array
// de strings com os ids de Department). Convenção:
//
//   []  (vazio)  → GERAL: todo mundo do Office vê.
//   [ids]        → só usuários DESSES departamentos (+ admin) veem.
//
// O departamento do usuário vem do cargo, igual ao resto do sistema:
//   User.position (nome) → Position.name (active) → Position.department_id.
// Admin vê tudo (sem filtro). Usuário sem cargo/departamento → só vê o GERAL.
//
// O `audiences` legado continua no banco e no código (dormant) para quando o
// Academy reabrir para público externo — mas as leituras internas usam ISTO.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

/**
 * Departamento(s) do usuário.
 *   admin                       → null  (vê tudo, sem filtro)
 *   sem cargo/departamento      → []    (só vê conteúdo GERAL)
 *   caso normal                 → [idDoDepartamento] (string)
 *
 * Mirror exato de trackService.getUserContext (cargo ativo casado por nome).
 */
export async function resolveUserDepartmentIds(userId) {
    if (!userId) return [];

    const user = await db.User.findByPk(userId, {
        attributes: ['id', 'role', 'position'],
        raw: true,
    });
    if (!user) return [];
    if (String(user.role || '').toLowerCase() === 'admin') return null; // admin vê tudo

    const posName = String(user.position || '').trim();
    if (!posName) return [];

    const pos = await db.Position.findOne({
        where: { active: true, name: { [Op.iLike]: posName } },
        attributes: ['department_id'],
        raw: true,
    });
    const depId = pos?.department_id;
    return depId != null ? [String(depId)] : [];
}

/**
 * Where-literal Sequelize que filtra registros visíveis para o conjunto de
 * departamentos do usuário. Convenção GERAL = array vazio.
 *   admin (deptIds === null) → TRUE (sem filtro)
 *   sempre inclui o GERAL (department_ids vazio/null)
 *   + registros cujo department_ids cruza com o(s) do usuário (?| ARRAY[...])
 */
export function departmentWhereLiteral(deptIds, columnName = 'department_ids') {
    if (deptIds === null) return db.Sequelize.literal('TRUE'); // admin vê tudo

    const col = String(columnName).replace(/[^a-zA-Z0-9_."]/g, '');
    const geral = `jsonb_array_length(COALESCE(${col}, '[]'::jsonb)) = 0`;

    // Sanitiza para apenas dígitos (ids) — defesa contra injeção pelo valor.
    const safe = (Array.isArray(deptIds) ? deptIds : [])
        .map((v) => String(v).replace(/[^0-9]/g, ''))
        .filter(Boolean)
        .map((v) => `'${v}'`)
        .join(',');

    if (!safe) return db.Sequelize.literal(`(${geral})`); // sem depto → só GERAL
    return db.Sequelize.literal(`(${geral} OR ${col} ?| ARRAY[${safe}])`);
}

/** Atalho: do userId direto para o where-literal de visibilidade. */
export async function departmentWhereForUser(userId, columnName = 'department_ids') {
    const deptIds = await resolveUserDepartmentIds(userId);
    return departmentWhereLiteral(deptIds, columnName);
}

/**
 * Normaliza a lista vinda do editor para gravar: ids inteiros positivos, únicos,
 * como STRINGS (compat com o operador ?|). [] = GERAL (todos). Máx. 100.
 */
export function normalizeDepartmentIds(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const out = [];
    for (const item of input) {
        const n = Number(item);
        if (!Number.isInteger(n) || n <= 0) continue;
        const s = String(n);
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= 100) break;
    }
    return out;
}

/** Departamentos ativos para o seletor do editor (id + nome). */
export async function listDepartments() {
    const rows = await db.Department.findAll({
        where: { active: true },
        attributes: ['id', 'name'],
        order: [['name', 'ASC']],
        raw: true,
    });
    return rows.map((r) => ({ id: r.id, name: r.name }));
}
