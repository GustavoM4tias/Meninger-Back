// services/permissions/departmentVisibilityService.js
//
// Visibilidade de DEPARTAMENTO em cascata: GLOBAL → CARGO (position) → USUÁRIO.
// Vence o MAIS ESPECÍFICO (usuário > cargo > global). Admin vê tudo.
//  - Nível global: tabela expense_department_visibility (name PK, hidden) — reaproveitada.
//  - Níveis cargo/usuário: tabela department_visibility_overrides (scope, scope_key, ...).
// É a fonte única do filtro de departamentos do Custos (enforce em expenseService).

import db from '../../models/sequelize/index.js';
import { listActiveDepartmentNames } from '../sienge/payableLiveService.js';

const { DepartmentVisibilityOverride, Sequelize } = db;
const { Op } = Sequelize;

/* ============================ Resolução (enforce) ============================ */

/**
 * Conjunto de departamentos OCULTOS para um usuário, resolvendo a cascata.
 * Admin (role==='admin') vê tudo → retorna [].
 */
export async function getHiddenDepartmentsForUser(user) {
    if (!user || user.role === 'admin') return [];

    const position = user.position ? String(user.position) : null;
    const userId = user.id != null ? String(user.id) : null;

    // Departamento (org) do usuário: cargo → positions.department_id → departments.name
    let orgDept = null;
    if (position) {
        try {
            const r = await db.sequelize.query(
                `SELECT d.name AS dept
                   FROM positions p JOIN departments d ON d.id = p.department_id
                  WHERE p.name = :pos LIMIT 1`,
                { replacements: { pos: position }, type: db.Sequelize.QueryTypes.SELECT }
            );
            orgDept = r?.[0]?.dept || null;
        } catch (e) { /* vínculo cargo→departamento pode não existir ainda */ }
    }

    // GLOBAL: expense_department_visibility (hidden=true)
    const globalRows = await db.sequelize.query(
        `SELECT name FROM expense_department_visibility WHERE hidden = true`,
        { type: db.Sequelize.QueryTypes.SELECT }
    );
    const eff = new Map(); // department_name -> hidden(bool)
    for (const r of globalRows) if (r.name) eff.set(r.name, true);

    // OVERRIDES: cargo + usuário (mais específico aplicado por último)
    const orConds = [];
    if (orgDept) orConds.push({ scope: 'department', scope_key: orgDept });
    if (position) orConds.push({ scope: 'position', scope_key: position });
    if (userId) orConds.push({ scope: 'user', scope_key: userId });

    if (orConds.length) {
        try {
            const rows = await DepartmentVisibilityOverride.findAll({
                where: { [Op.or]: orConds },
                attributes: ['scope', 'department_name', 'hidden'],
            });
            // ordem: departamento → cargo → usuário (o mais específico vence)
            for (const r of rows) if (r.scope === 'department') eff.set(r.department_name, !!r.hidden);
            for (const r of rows) if (r.scope === 'position') eff.set(r.department_name, !!r.hidden);
            for (const r of rows) if (r.scope === 'user') eff.set(r.department_name, !!r.hidden);
        } catch (e) {
            // tabela ainda não existe (criada no boot via ensureSchema) — usa só o global
            console.warn('[deptVisibility] overrides indisponíveis, usando só global:', e.message);
        }
    }

    const hidden = [];
    for (const [dept, h] of eff) if (h) hidden.push(dept);
    return hidden;
}

/* ============================ Config (admin UI) ============================ */

// Lista de departamentos que podem ser configurados. Fonte AO VIVO: departamentos
// ativos do Sienge (ecaddepartamento) unidos aos já configurados em
// expense_department_visibility (para nomes legados continuarem aparecendo).
export async function listDepartments() {
    const [liveNames, cfgRows] = await Promise.all([
        listActiveDepartmentNames().catch(() => []),
        db.sequelize.query(
            `SELECT DISTINCT name FROM expense_department_visibility WHERE name IS NOT NULL AND TRIM(name) <> ''`,
            { type: db.Sequelize.QueryTypes.SELECT }
        ),
    ]);
    const set = new Set();
    for (const n of liveNames) if (n && n.trim()) set.add(n.trim());
    for (const r of cfgRows) if (r.name && r.name.trim()) set.add(r.name.trim());
    return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// Cargos distintos (position) dos usuários ativos.
export async function listPositions() {
    const rows = await db.sequelize.query(
        `SELECT DISTINCT position FROM users
          WHERE position IS NOT NULL AND TRIM(position) <> '' AND status = true
          ORDER BY position ASC`,
        { type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows.map((r) => r.position);
}

// Usuários ativos do Office (para o seletor de override por usuário).
export async function listUsers() {
    const rows = await db.sequelize.query(
        `SELECT id, username, position FROM users
          WHERE status = true AND auth_provider IN ('INTERNAL','MICROSOFT')
          ORDER BY username ASC`,
        { type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows.map((r) => ({ id: r.id, name: r.username, position: r.position }));
}

// Departamentos da ORGANIZAÇÃO (cada cargo pertence a um) — chaves do nível "por departamento".
export async function listOrgDepartments() {
    const rows = await db.sequelize.query(
        `SELECT name FROM departments WHERE active = true ORDER BY name ASC`,
        { type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows.map((r) => r.name);
}

// Regras de UM escopo: { [department_name]: hidden }. Para global lê expense_department_visibility.
export async function getRules(scope, key) {
    if (scope === 'global') {
        const rows = await db.sequelize.query(
            `SELECT name, hidden FROM expense_department_visibility`,
            { type: db.Sequelize.QueryTypes.SELECT }
        );
        const map = {};
        for (const r of rows) map[r.name] = !!r.hidden;
        return map;
    }
    if (!['department', 'position', 'user'].includes(scope)) throw new Error('scope inválido.');
    const rows = await DepartmentVisibilityOverride.findAll({
        where: { scope, scope_key: String(key) },
        attributes: ['department_name', 'hidden'],
    });
    const map = {};
    for (const r of rows) map[r.department_name] = !!r.hidden;
    return map;
}

// Define/atualiza UMA regra (scope global/position/user). hidden boolean.
export async function setRule({ scope, key, departmentName, hidden }, updatedBy) {
    const dept = String(departmentName || '').trim();
    if (!dept) throw new Error('departmentName é obrigatório.');

    if (scope === 'global') {
        await db.sequelize.query(
            `INSERT INTO expense_department_visibility (name, hidden, updated_by, created_at, updated_at)
             VALUES (:name, :hidden, :by, NOW(), NOW())
             ON CONFLICT (name) DO UPDATE
               SET hidden = EXCLUDED.hidden, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
            { replacements: { name: dept, hidden: !!hidden, by: updatedBy || null } }
        );
        return { scope, departmentName: dept, hidden: !!hidden };
    }

    if (!['department', 'position', 'user'].includes(scope)) throw new Error('scope inválido.');
    const scope_key = String(key || '').trim();
    if (!scope_key) throw new Error('key (cargo/usuário) é obrigatório.');

    // upsert manual (ON CONFLICT via SQL p/ não depender de unique no model do sync)
    await db.sequelize.query(
        `INSERT INTO department_visibility_overrides (scope, scope_key, department_name, hidden, updated_by, created_at, updated_at)
         VALUES (:scope, :key, :dept, :hidden, :by, NOW(), NOW())
         ON CONFLICT (scope, scope_key, department_name) DO UPDATE
           SET hidden = EXCLUDED.hidden, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        { replacements: { scope, key: scope_key, dept, hidden: !!hidden, by: updatedBy || null } }
    );
    return { scope, key: scope_key, departmentName: dept, hidden: !!hidden };
}

// Remove uma regra (volta a herdar do nível acima). Para global, apaga a linha.
export async function clearRule({ scope, key, departmentName }) {
    const dept = String(departmentName || '').trim();
    if (scope === 'global') {
        await db.sequelize.query(`DELETE FROM expense_department_visibility WHERE name = :name`, {
            replacements: { name: dept },
        });
        return;
    }
    await DepartmentVisibilityOverride.destroy({
        where: { scope, scope_key: String(key), department_name: dept },
    });
}

export default {
    getHiddenDepartmentsForUser,
    listDepartments,
    listPositions,
    listUsers,
    listOrgDepartments,
    getRules,
    setRule,
    clearRule,
};
