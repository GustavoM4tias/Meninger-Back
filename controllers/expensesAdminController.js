// controllers/expensesAdminController.js
//
// Endpoints admin para gestão da tela Custos:
//   1. cost_center_overrides — sobrepor nome exibido por CC
//   2. expense_department_visibility — escolher quais departamentos aparecem no filtro

import db from '../models/sequelize/index.js';
import { listActiveDepartmentNames } from '../services/sienge/payableLiveService.js';

const { CostCenterOverride, ExpenseDepartmentVisibility, sequelize, Sequelize } = db;

function ensureAdmin(req, res) {
    if (!req.user) {
        res.status(401).json({ error: 'Usuário não autenticado.' });
        return false;
    }
    if (req.user.role !== 'admin') {
        res.status(403).json({ error: 'Apenas administradores.' });
        return false;
    }
    return true;
}

// ── COST CENTER OVERRIDES ──────────────────────────────────────────────────

/** GET /api/expenses/admin/cost-center-overrides — lista completa (admin) */
export const listCostCenterOverrides = async (req, res) => {
    if (!ensureAdmin(req, res)) return;
    try {
        const rows = await CostCenterOverride.findAll({
            order: [['cost_center_id', 'ASC']],
        });
        return res.json(rows);
    } catch (err) {
        console.error('[expensesAdmin] listCostCenterOverrides erro:', err?.message);
        return res.status(500).json({ error: err.message });
    }
};

/**
 * GET /api/expenses/cost-center-overrides/map
 * Mapa leve { "<cost_center_id>": "Nome de exibição" } para qualquer usuário autenticado.
 * Usado pelos selectors (Custos/Títulos) aplicarem o nome de exibição.
 */
export const getCostCenterOverrideMap = async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
    try {
        const rows = await CostCenterOverride.findAll({
            attributes: ['cost_center_id', 'display_name'],
        });
        const map = {};
        for (const r of rows) map[String(r.cost_center_id)] = r.display_name;
        return res.json(map);
    } catch (err) {
        console.error('[expensesAdmin] getCostCenterOverrideMap erro:', err?.message);
        return res.status(500).json({ error: err.message });
    }
};

/** PUT /api/expenses/admin/cost-center-overrides/:ccId  body: { displayName } */
export const setCostCenterOverride = async (req, res) => {
    if (!ensureAdmin(req, res)) return;
    const ccId = Number(req.params.ccId);
    const displayName = String(req.body?.displayName || '').trim();
    if (!Number.isFinite(ccId)) {
        return res.status(400).json({ error: 'cost_center_id inválido.' });
    }
    if (!displayName) {
        return res.status(400).json({ error: 'displayName é obrigatório.' });
    }
    try {
        const updatedBy = req.user.name || req.user.email || String(req.user.id);
        await sequelize.query(
            `INSERT INTO cost_center_overrides (cost_center_id, display_name, updated_by, created_at, updated_at)
             VALUES (:ccId, :name, :by, NOW(), NOW())
             ON CONFLICT (cost_center_id) DO UPDATE
               SET display_name = EXCLUDED.display_name,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
            { replacements: { ccId, name: displayName, by: updatedBy } }
        );
        return res.json({ ok: true, costCenterId: ccId, displayName });
    } catch (err) {
        console.error('[expensesAdmin] setCostCenterOverride erro:', err?.message, '| parent:', err?.parent?.message);
        return res.status(500).json({ error: err.message, sqlDetail: err?.parent?.message });
    }
};

/** DELETE /api/expenses/admin/cost-center-overrides/:ccId — remove o override */
export const deleteCostCenterOverride = async (req, res) => {
    if (!ensureAdmin(req, res)) return;
    const ccId = Number(req.params.ccId);
    if (!Number.isFinite(ccId)) {
        return res.status(400).json({ error: 'cost_center_id inválido.' });
    }
    try {
        const deleted = await CostCenterOverride.destroy({ where: { cost_center_id: ccId } });
        return res.json({ ok: true, removed: deleted });
    } catch (err) {
        console.error('[expensesAdmin] deleteCostCenterOverride erro:', err?.message);
        return res.status(500).json({ error: err.message });
    }
};

// ── DEPARTMENT VISIBILITY ──────────────────────────────────────────────────

/**
 * GET /api/expenses/admin/department-visibility
 * Devolve a lista de TODOS os departamentos vistos em bills + estado de hidden.
 * Não-existentes na tabela = visíveis (default).
 */
export const listDepartmentVisibility = async (req, res) => {
    if (!ensureAdmin(req, res)) return;
    try {
        // 1) Departamentos ativos do Sienge (ao vivo) ∪ os que já têm flag salva
        const [liveNames, flags] = await Promise.all([
            listActiveDepartmentNames().catch(() => []),
            ExpenseDepartmentVisibility.findAll(),
        ]);
        const hiddenSet = new Set(flags.filter(f => f.hidden).map(f => f.name));

        const set = new Set();
        for (const n of liveNames) if (n && n.trim()) set.add(n.trim());
        for (const f of flags) if (f.name && f.name.trim()) set.add(f.name.trim());

        const departments = [...set]
            .sort((a, b) => a.localeCompare(b, 'pt-BR'))
            .map(name => ({ name, hidden: hiddenSet.has(name) }));

        return res.json({ departments });
    } catch (err) {
        console.error('[expensesAdmin] listDepartmentVisibility erro:', err?.message);
        return res.status(500).json({ error: err.message });
    }
};

/** PUT /api/expenses/admin/department-visibility  body: { name, hidden } */
export const setDepartmentVisibility = async (req, res) => {
    if (!ensureAdmin(req, res)) return;
    const name = String(req.body?.name || '').trim();
    const hidden = req.body?.hidden === true;
    if (!name) {
        return res.status(400).json({ error: 'name é obrigatório.' });
    }
    try {
        const updatedBy = req.user.name || req.user.email || String(req.user.id);
        await sequelize.query(
            `INSERT INTO expense_department_visibility (name, hidden, updated_by, created_at, updated_at)
             VALUES (:name, :hidden, :by, NOW(), NOW())
             ON CONFLICT (name) DO UPDATE
               SET hidden = EXCLUDED.hidden,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
            { replacements: { name, hidden, by: updatedBy } }
        );
        return res.json({ ok: true, name, hidden });
    } catch (err) {
        console.error('[expensesAdmin] setDepartmentVisibility erro:', err?.message);
        return res.status(500).json({ error: err.message, sqlDetail: err?.parent?.message });
    }
};
