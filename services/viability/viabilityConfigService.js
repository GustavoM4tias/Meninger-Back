// services/viability/viabilityConfigService.js
//
// Config admin da Viabilidade de Marketing:
//  - quais departamentos contam como "marketing" (global + exceções por empresa Sienge)
//  - quantas unidades bloqueadas considerar disponíveis (por empresa, padrão 0)
//
// A config "por empresa" é chaveada por company_id (empresa Sienge = empreendimento),
// que é a unidade de agrupamento do relatório. O resolver buildMarketingResolver() é
// o que o motor de cálculo usa para decidir se uma despesa conta como marketing e
// quantas bloqueadas liberar.

import db from '../../models/sequelize/index.js';

const { ViabilityMarketingDepartment, ViabilityEnterpriseSettings } = db;

// Normaliza nome de departamento para comparação robusta (sem acento, minúsculo, trim).
const norm = (s) =>
    String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .toLowerCase();

/* ============================ Departamentos (global) ============================ */

// Lista os department_name distintos já vistos nas despesas — fonte para o admin escolher.
export async function listKnownDepartments() {
    const rows = await db.sequelize.query(
        `SELECT DISTINCT department_name AS name
           FROM expenses
          WHERE department_name IS NOT NULL AND TRIM(department_name) <> ''
          ORDER BY department_name ASC`,
        { type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows.map((r) => r.name);
}

export async function listMarketingDepartments() {
    const rows = await ViabilityMarketingDepartment.findAll({ order: [['department_name', 'ASC']] });
    return rows.map((r) => r.toJSON());
}

export async function setMarketingDepartment(name, isMarketing, updatedBy) {
    const department_name = String(name || '').trim();
    if (!department_name) throw new Error('department_name é obrigatório.');
    await ViabilityMarketingDepartment.upsert({
        department_name,
        is_marketing: !!isMarketing,
        updated_by: updatedBy || null,
    });
    return { department_name, is_marketing: !!isMarketing };
}

/* ============== Configuração por empresa Sienge (company_id) ============== */

export async function listEnterpriseSettings() {
    const rows = await ViabilityEnterpriseSettings.findAll();
    return rows.map((r) => r.toJSON());
}

export async function getEnterpriseSettings(companyId) {
    const id = Number(companyId);
    if (!Number.isFinite(id)) return null;
    const row = await ViabilityEnterpriseSettings.findByPk(id);
    return row ? row.toJSON() : null;
}

export async function setEnterpriseSettings(companyId, { blockedConsideredAvailable, marketingDeptOverrides, statusOverride } = {}, updatedBy) {
    const company_id = Number(companyId);
    if (!Number.isFinite(company_id)) throw new Error('company_id inválido.');

    const payload = { company_id, updated_by: updatedBy || null };
    if (blockedConsideredAvailable !== undefined) {
        payload.blocked_considered_available = Math.max(0, parseInt(blockedConsideredAvailable, 10) || 0);
    }
    if (marketingDeptOverrides !== undefined) {
        payload.marketing_dept_overrides = marketingDeptOverrides || null;
    }
    if (statusOverride !== undefined) {
        const allowed = ['concluido', 'em_andamento', 'previsao_futura'];
        payload.status_override = allowed.includes(statusOverride) ? statusOverride : null;
    }

    await ViabilityEnterpriseSettings.upsert(payload);
    return getEnterpriseSettings(company_id);
}

/* ============================ Resolver (motor) ============================ */

/**
 * Carrega config global + overrides numa passada e devolve helpers síncronos:
 *  - isMarketing(deptName, companyId): boolean
 *  - blockedConsideredAvailable(companyId): number (default 0)
 *  - hasAnyMarketingConfig: se existe ao menos 1 depto global marcado como marketing
 */
export async function buildMarketingResolver() {
    const [globalRows, entRows] = await Promise.all([
        ViabilityMarketingDepartment.findAll(),
        ViabilityEnterpriseSettings.findAll(),
    ]);

    const globalMap = new Map(); // norm(name) -> bool
    let anyMarketing = false;
    for (const r of globalRows) {
        const v = !!r.is_marketing;
        globalMap.set(norm(r.department_name), v);
        if (v) anyMarketing = true;
    }

    const overridesByCompany = new Map(); // company_id -> Map(norm(name) -> bool)
    const blockedByCompany = new Map();   // company_id -> number
    const statusByCompany = new Map();    // company_id -> 'concluido'|'em_andamento'|'previsao_futura'|null
    for (const r of entRows) {
        const key = Number(r.company_id);
        const ov = r.marketing_dept_overrides || {};
        const m = new Map();
        for (const [k, val] of Object.entries(ov)) m.set(norm(k), !!val);
        overridesByCompany.set(key, m);
        blockedByCompany.set(key, Math.max(0, Number(r.blocked_considered_available || 0)));
        statusByCompany.set(key, r.status_override || null);
    }

    function isMarketing(deptName, companyId) {
        const key = norm(deptName);
        if (!key) return false;
        const ov = overridesByCompany.get(Number(companyId));
        if (ov && ov.has(key)) return ov.get(key);
        return globalMap.get(key) === true;
    }

    function blockedConsideredAvailable(companyId) {
        return blockedByCompany.get(Number(companyId)) || 0;
    }

    function statusOverride(companyId) {
        return statusByCompany.get(Number(companyId)) || null;
    }

    return { isMarketing, blockedConsideredAvailable, statusOverride, hasAnyMarketingConfig: anyMarketing };
}

export default {
    listKnownDepartments,
    listMarketingDepartments,
    setMarketingDepartment,
    listEnterpriseSettings,
    getEnterpriseSettings,
    setEnterpriseSettings,
    buildMarketingResolver,
};
