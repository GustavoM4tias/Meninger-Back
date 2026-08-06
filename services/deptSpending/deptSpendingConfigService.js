// services/deptSpending/deptSpendingConfigService.js
//
// Config admin + governança da tela "Gastos por Departamento":
//  - quais departamentos têm o gasto acompanhado (global + exceções por empresa)
//  - quantas unidades bloqueadas considerar disponíveis (por empresa, padrão 0)
//  - LIBERAÇÃO e status por EMPREENDIMENTO (etapa/CC)
//
// DOIS NÍVEIS:
//  - EMPRESA Sienge (company_id, tabela viability_enterprise_settings): o que vale
//    para a SPE inteira (departamentos acompanhados, bucket Loja, bloqueadas).
//  - EMPREENDIMENTO (enterprise_key = CC, tabela viability_stage_settings): o que é
//    decisão de etapa (liberação p/ diretoria, status manual, leitura da IA). Sem
//    linha de etapa, cai no ajuste da empresa (compatibilidade com o que já existia).
//
// O resolver buildSpendingResolver() é o que o motor de cálculo usa para decidir se
// uma despesa é acompanhada, o status e se o empreendimento está liberado.

import db from '../../models/sequelize/index.js';
import { listActiveDepartmentNames } from '../sienge/payableLiveService.js';

const { DeptSpendingMarketingDepartment, DeptSpendingEnterpriseSettings, DeptSpendingStageSettings } = db;

// Normaliza nome de departamento para comparação robusta (sem acento, minúsculo, trim).
const norm = (s) =>
    String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .toLowerCase();

/* ============================ Departamentos (global) ============================ */

// Departamentos ativos do Sienge (ao vivo) — fonte para o admin escolher quais acompanhar.
export async function listKnownDepartments() {
    return await listActiveDepartmentNames();
}

export async function listMarketingDepartments() {
    const rows = await DeptSpendingMarketingDepartment.findAll({ order: [['department_name', 'ASC']] });
    return rows.map((r) => r.toJSON());
}

export async function setMarketingDepartment(name, isMarketing, updatedBy) {
    const department_name = String(name || '').trim();
    if (!department_name) throw new Error('department_name é obrigatório.');
    await DeptSpendingMarketingDepartment.upsert({
        department_name,
        is_marketing: !!isMarketing,
        updated_by: updatedBy || null,
    });
    return { department_name, is_marketing: !!isMarketing };
}

/* ============== Configuração por empresa Sienge (company_id) ============== */

export async function listEnterpriseSettings() {
    const rows = await DeptSpendingEnterpriseSettings.findAll();
    return rows.map((r) => r.toJSON());
}

export async function getEnterpriseSettings(companyId) {
    const id = Number(companyId);
    if (!Number.isFinite(id)) return null;
    const row = await DeptSpendingEnterpriseSettings.findByPk(id);
    return row ? row.toJSON() : null;
}

const ALLOWED_STATUS = ['concluido', 'em_andamento', 'pre_lancamento', 'previsao_futura'];

export async function setEnterpriseSettings(companyId, { blockedConsideredAvailable, marketingDeptOverrides, statusOverride, lojaDepartments } = {}, updatedBy) {
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
        payload.status_override = ALLOWED_STATUS.includes(statusOverride) ? statusOverride : null;
    }
    if (lojaDepartments !== undefined) {
        // Bucket LOJA do relatório: lista de nomes de departamento (ou null p/ nenhum).
        const list = Array.isArray(lojaDepartments)
            ? lojaDepartments.map((d) => String(d || '').trim()).filter(Boolean)
            : [];
        payload.loja_departments = list.length ? list : null;
    }

    await DeptSpendingEnterpriseSettings.upsert(payload);
    return getEnterpriseSettings(company_id);
}

/* ============== Configuração por EMPREENDIMENTO (enterprise_key = CC) ============== */

const normKey = (v) => {
    const k = String(v ?? '').trim();
    return k || null;
};

export async function listStageSettings() {
    const rows = await DeptSpendingStageSettings.findAll();
    return rows.map((r) => r.toJSON());
}

export async function getStageSettings(enterpriseKey) {
    const key = normKey(enterpriseKey);
    if (!key) return null;
    const row = await DeptSpendingStageSettings.findByPk(key);
    return row ? row.toJSON() : null;
}

export async function setStageSettings(enterpriseKey, { statusOverride, companyId } = {}, updatedBy) {
    const key = normKey(enterpriseKey);
    if (!key) throw new Error('enterprise_key inválido.');

    const payload = { enterprise_key: key, updated_by: updatedBy || null };
    if (companyId !== undefined && Number.isFinite(Number(companyId))) payload.company_id = Number(companyId);
    if (statusOverride !== undefined) {
        payload.status_override = ALLOWED_STATUS.includes(statusOverride) ? statusOverride : null;
    }

    await DeptSpendingStageSettings.upsert(payload);
    return getStageSettings(key);
}

/* ===== Cache da narrativa IA ("Leitura para decisão") ===== */
// Relatório de etapa grava na etapa; relatório da empresa inteira (rota legada)
// continua gravando na empresa.

export async function getReportInsightsCache({ enterpriseKey = null, companyId = null } = {}) {
    if (normKey(enterpriseKey)) {
        const stage = await getStageSettings(enterpriseKey);
        return stage?.report_insights || null;
    }
    const row = await getEnterpriseSettings(companyId);
    return row?.report_insights || null;
}

export async function setReportInsightsCache({ enterpriseKey = null, companyId = null } = {}, insights) {
    const key = normKey(enterpriseKey);
    if (key) {
        const payload = { enterprise_key: key, report_insights: insights || null };
        if (Number.isFinite(Number(companyId))) payload.company_id = Number(companyId);
        await DeptSpendingStageSettings.upsert(payload);
        return insights || null;
    }
    const company_id = Number(companyId);
    if (!Number.isFinite(company_id)) throw new Error('company_id inválido.');
    await DeptSpendingEnterpriseSettings.upsert({ company_id, report_insights: insights || null });
    return insights || null;
}

/* ============================ Liberação (rascunho → liberado) ============================ */

// Liberação por EMPREENDIMENTO (etapa): a linha da tela é uma etapa da projeção,
// então a chave é o enterprise_key (CC). Liberar uma etapa não libera as irmãs.
export async function setStageRelease(enterpriseKey, { isReleased, notes, companyId } = {}, actor) {
    const key = normKey(enterpriseKey);
    if (!key) throw new Error('enterprise_key inválido (empreendimento sem centro de custo).');

    const released = !!isReleased;
    const payload = {
        enterprise_key: key,
        is_released: released,
        release_notes: notes !== undefined ? (notes || null) : undefined,
        released_by: released ? (actor || null) : null,
        released_at: released ? new Date() : null,
        updated_by: actor || null,
    };
    if (companyId !== undefined && Number.isFinite(Number(companyId))) payload.company_id = Number(companyId);
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    await DeptSpendingStageSettings.upsert(payload);
    return getStageSettings(key);
}

// Liberação por EMPRESA (legado): mantida para a rota antiga e como fallback das
// etapas que ainda não têm ajuste próprio.
export async function setEnterpriseRelease(companyId, { isReleased, notes } = {}, actor) {
    const company_id = Number(companyId);
    if (!Number.isFinite(company_id)) throw new Error('company_id inválido (empreendimento sem vínculo Sienge).');

    const released = !!isReleased;
    const payload = {
        company_id,
        is_released: released,
        release_notes: notes !== undefined ? (notes || null) : undefined,
        released_by: released ? (actor || null) : null,
        released_at: released ? new Date() : null,
        updated_by: actor || null,
    };
    // remove chaves undefined para não sobrescrever notes quando não enviado
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    await DeptSpendingEnterpriseSettings.upsert(payload);
    return getEnterpriseSettings(company_id);
}

/* ============================ Resolver (motor) ============================ */

/**
 * Carrega config global + overrides + liberação numa passada e devolve helpers
 * síncronos:
 *  - isMarketing(deptName, companyId): boolean (depto acompanhado?)
 *  - statusOverride(companyId, enterpriseKey): string|null
 *  - isReleased(companyId, enterpriseKey): boolean (liberado para a diretoria?)
 *  - hasAnyMarketingConfig: se existe ao menos 1 depto global marcado
 *
 * Status e liberação olham PRIMEIRO o ajuste da etapa (enterprise_key); sem linha
 * de etapa, valem os da empresa.
 */
export async function buildSpendingResolver() {
    const [globalRows, entRows, stageRows] = await Promise.all([
        DeptSpendingMarketingDepartment.findAll(),
        DeptSpendingEnterpriseSettings.findAll(),
        DeptSpendingStageSettings.findAll(),
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
    const statusByCompany = new Map();    // company_id -> status | null
    const releasedByCompany = new Map();  // company_id -> bool
    const lojaByCompany = new Map();      // company_id -> [nomes originais] (bucket Loja)
    for (const r of entRows) {
        const key = Number(r.company_id);
        const ov = r.marketing_dept_overrides || {};
        const m = new Map();
        for (const [k, val] of Object.entries(ov)) m.set(norm(k), !!val);
        overridesByCompany.set(key, m);
        blockedByCompany.set(key, Math.max(0, Number(r.blocked_considered_available || 0)));
        statusByCompany.set(key, r.status_override || null);
        releasedByCompany.set(key, !!r.is_released);
        lojaByCompany.set(key, Array.isArray(r.loja_departments) ? r.loja_departments.filter(Boolean) : []);
    }

    const statusByStage = new Map();   // enterprise_key -> status | null
    const releasedByStage = new Map(); // enterprise_key -> bool
    for (const r of stageRows) {
        const key = String(r.enterprise_key);
        statusByStage.set(key, r.status_override || null);
        releasedByStage.set(key, !!r.is_released);
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

    function statusOverride(companyId, enterpriseKey) {
        const key = normKey(enterpriseKey);
        if (key && statusByStage.has(key)) return statusByStage.get(key) || null;
        return statusByCompany.get(Number(companyId)) || null;
    }

    function isReleased(companyId, enterpriseKey) {
        const key = normKey(enterpriseKey);
        if (key && releasedByStage.has(key)) return releasedByStage.get(key) === true;
        return releasedByCompany.get(Number(companyId)) === true;
    }

    // Bucket LOJA do relatório: nomes de depto configurados p/ a empresa (relatório gerencial).
    function lojaDepartments(companyId) {
        return lojaByCompany.get(Number(companyId)) || [];
    }
    function isLoja(deptName, companyId) {
        const key = norm(deptName);
        if (!key) return false;
        return lojaDepartments(companyId).some((d) => norm(d) === key);
    }

    // "Configurado" p/ o relatório: existe bucket marketing resolvível p/ a empresa
    // (algum depto global marcado OU algum override true no empreendimento).
    function isConfigured(companyId) {
        if (anyMarketing) return true;
        const ov = overridesByCompany.get(Number(companyId));
        if (!ov) return false;
        for (const v of ov.values()) if (v) return true;
        return false;
    }

    return {
        isMarketing, blockedConsideredAvailable, statusOverride, isReleased,
        lojaDepartments, isLoja, isConfigured,
        hasAnyMarketingConfig: anyMarketing,
    };
}

export default {
    listKnownDepartments,
    listMarketingDepartments,
    setMarketingDepartment,
    listEnterpriseSettings,
    getEnterpriseSettings,
    setEnterpriseSettings,
    setEnterpriseRelease,
    listStageSettings,
    getStageSettings,
    setStageSettings,
    setStageRelease,
    getReportInsightsCache,
    setReportInsightsCache,
    buildSpendingResolver,
};
