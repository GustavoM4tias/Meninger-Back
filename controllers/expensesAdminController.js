// controllers/expensesAdminController.js
//
// Endpoints admin para gestão da tela Custos:
//   1. cost_center_overrides — sobrepor nome exibido por CC
//   2. expense_department_visibility — escolher quais departamentos aparecem no filtro

import db from '../models/sequelize/index.js';

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

/** GET /api/expenses/admin/cost-center-overrides */
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

/** PUT /api/expenses/admin/cost-center-overrides/:ccId  body: { displayName } */
export const setCostCenterOverride = async (req, res) => {
    console.log('[CCOverride] >>> PUT body=', req.body, ' params=', req.params, ' user=', req.user?.id, ' role=', req.user?.role);
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

        // Verificação RAW imediata: prova que o registro está no banco depois do INSERT
        const [verify] = await sequelize.query(
            `SELECT cost_center_id, display_name FROM cost_center_overrides WHERE cost_center_id = :ccId`,
            { replacements: { ccId } }
        );
        console.log('[CCOverride] <<< persistido:', verify[0] || '(NENHUM!)');

        return res.json({
            ok: true,
            costCenterId: ccId,
            displayName,
            verifiedInDb: verify.length > 0,
        });
    } catch (err) {
        console.error('[CCOverride] !!! ERRO:');
        console.error('  message:', err?.message);
        console.error('  parent :', err?.parent?.message);
        console.error('  sql    :', err?.sql);
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
        // 1) Pega todos os departamentos distintos vistos em sienge_bills
        const rowsAll = await sequelize.query(
            `SELECT DISTINCT main_department_name AS name
             FROM sienge_bills
             WHERE main_department_name IS NOT NULL
               AND TRIM(main_department_name) <> ''
             ORDER BY main_department_name`,
            { type: Sequelize.QueryTypes.SELECT }
        );

        // 2) Pega flags atuais
        const flags = await ExpenseDepartmentVisibility.findAll();
        const hiddenSet = new Set(flags.filter(f => f.hidden).map(f => f.name));

        const departments = rowsAll.map(r => ({
            name: r.name,
            hidden: hiddenSet.has(r.name),
        }));

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
