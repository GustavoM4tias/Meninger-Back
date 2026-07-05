// services/emeAtende/EmeAtendeFlowService.js
// Segmentação: aplica eme_atende_flow_rules em ordem de prioridade pra decidir qual
// fluxo atende cada lead. Cache 30s - editar regra/fluxo aplica na conversa
// seguinte, sem deploy.

import db from '../../models/sequelize/index.js';

const CACHE_TTL_MS = 30 * 1000;
let _cache = { at: 0, rules: null, defaultFlow: null };

function invalidate() {
    _cache = { at: 0, rules: null, defaultFlow: null };
}

async function load() {
    const now = Date.now();
    if (_cache.rules && now - _cache.at < CACHE_TTL_MS) return _cache;
    const rules = await db.EmeAtendeFlowRule.findAll({
        where: { active: true },
        include: [{ model: db.EmeAtendeFlow, as: 'flow' }],
        order: [['priority', 'ASC'], ['id', 'ASC']],
    });
    const defaultFlow = await db.EmeAtendeFlow.findOne({ where: { is_default: true, active: true } })
        || await db.EmeAtendeFlow.findOne({ where: { active: true }, order: [['id', 'ASC']] });
    _cache = { at: now, rules, defaultFlow };
    return _cache;
}

function leadFieldValue(lead, field) {
    const direct = lead[field];
    if (direct !== undefined && direct !== null) return String(direct);
    const fromPayload = lead.payload?.[field];
    return fromPayload === undefined || fromPayload === null ? null : String(fromPayload);
}

function ruleMatches(rule, fieldValue) {
    if (fieldValue === null) return false;
    const val = String(rule.value);
    switch (rule.operator) {
        case 'equals': return fieldValue.toLowerCase() === val.toLowerCase();
        case 'contains': return fieldValue.toLowerCase().includes(val.toLowerCase());
        case 'regex':
            try { return new RegExp(val, 'i').test(fieldValue); } catch { return false; }
        default: return false;
    }
}

/** Primeira regra que casa vence; sem match → fluxo default. */
async function matchFlow(lead) {
    const { rules, defaultFlow } = await load();
    for (const rule of rules) {
        if (!rule.flow || !rule.flow.active) continue;
        if (ruleMatches(rule, leadFieldValue(lead, rule.field))) {
            return { flow: rule.flow, matchedRule: rule };
        }
    }
    return { flow: defaultFlow, matchedRule: null };
}

async function getDefaultFlow() {
    const { defaultFlow } = await load();
    return defaultFlow;
}

async function getFlow(id) {
    if (!id) return getDefaultFlow();
    return await db.EmeAtendeFlow.findByPk(id) || getDefaultFlow();
}

export default { matchFlow, getDefaultFlow, getFlow, invalidate };
