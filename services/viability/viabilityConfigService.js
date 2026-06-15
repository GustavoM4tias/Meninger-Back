// services/viability/viabilityConfigService.js
//
// Config admin da Viabilidade de Marketing:
//  - quais departamentos contam como "marketing" (global + exceções por empreendimento)
//  - quantas unidades bloqueadas considerar disponíveis (por empreendimento, padrão 0)
//
// O resolver buildMarketingResolver() é o que o motor de cálculo (Fase 3) usa para
// decidir se uma despesa conta como marketing e quantas bloqueadas liberar.

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

/* ====================== Configuração por empreendimento ====================== */

export async function listEnterpriseSettings() {
    const rows = await ViabilityEnterpriseSettings.findAll();
    return rows.map((r) => r.toJSON());
}

export async function getEnterpriseSettings(enterpriseKey) {
    const row = await ViabilityEnterpriseSettings.findByPk(String(enterpriseKey));
    return row ? row.toJSON() : null;
}

export async function setEnterpriseSettings(enterpriseKey, { blockedConsideredAvailable, marketingDeptOverrides } = {}, updatedBy) {
    const enterprise_key = String(enterpriseKey || '').trim();
    if (!enterprise_key) throw new Error('enterprise_key é obrigatório.');

    const payload = { enterprise_key, updated_by: updatedBy || null };
    if (blockedConsideredAvailable !== undefined) {
        payload.blocked_considered_available = Math.max(0, parseInt(blockedConsideredAvailable, 10) || 0);
    }
    if (marketingDeptOverrides !== undefined) {
        payload.marketing_dept_overrides = marketingDeptOverrides || null;
    }

    await ViabilityEnterpriseSettings.upsert(payload);
    return getEnterpriseSettings(enterprise_key);
}

/* ============================ Resolver (Fase 3) ============================ */

/**
 * Carrega config global + overrides numa passada e devolve helpers síncronos:
 *  - isMarketing(deptName, enterpriseKey): boolean
 *  - blockedConsideredAvailable(enterpriseKey): number (default 0)
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

    const overridesByEnt = new Map(); // enterprise_key -> Map(norm(name) -> bool)
    const blockedByEnt = new Map();   // enterprise_key -> number
    for (const r of entRows) {
        const key = String(r.enterprise_key);
        const ov = r.marketing_dept_overrides || {};
        const m = new Map();
        for (const [k, val] of Object.entries(ov)) m.set(norm(k), !!val);
        overridesByEnt.set(key, m);
        blockedByEnt.set(key, Math.max(0, Number(r.blocked_considered_available || 0)));
    }

    function isMarketing(deptName, enterpriseKey) {
        const key = norm(deptName);
        if (!key) return false;
        const ov = overridesByEnt.get(String(enterpriseKey));
        if (ov && ov.has(key)) return ov.get(key);
        return globalMap.get(key) === true;
    }

    function blockedConsideredAvailable(enterpriseKey) {
        return blockedByEnt.get(String(enterpriseKey)) || 0;
    }

    return { isMarketing, blockedConsideredAvailable, hasAnyMarketingConfig: anyMarketing };
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
