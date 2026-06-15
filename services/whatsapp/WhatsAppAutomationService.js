// services/whatsapp/WhatsAppAutomationService.js
//
// Leitura DB-driven das automações de WhatsApp, com cache curto e FALLBACK ao
// comportamento atual codificado — assim, antes do seed (ou se o DB falhar), o
// runtime se comporta exatamente como hoje. Mesma filosofia do ConfigService do
// Cérebro da Eme.

import db from '../../models/sequelize/index.js';

let _cache = null; // { at, byKey: Map }
const TTL_MS = 30 * 1000;

// Comportamento atual codificado — usado quando a tabela não tem a chave.
const FALLBACK = {
  alert_generic: {
    key: 'alert_generic',
    name: 'Alerta da Eme',
    enabled: true,
    triggerType: 'manual',
    templateName: 'alert_generic_v2',
    templateLanguage: 'pt_BR',
    variableMapping: { '1': 'owner.username', '2': 'title' },
    buttons: [{ text: 'SIM', action: 'yes' }, { text: 'NÃO', action: 'no' }],
    replyActions: { yes: { type: 'send_report' }, no: { type: 'cancel' } },
    recipients: { mode: 'owner' },
    category: 'UTILITY',
    isSystem: true,
  },
};

function rowToObj(r) {
  return {
    id: r.id, key: r.key, name: r.name, description: r.description, enabled: r.enabled,
    triggerType: r.triggerType, triggerConfig: r.triggerConfig,
    templateName: r.templateName, templateLanguage: r.templateLanguage,
    variableMapping: r.variableMapping, buttons: r.buttons,
    replyActions: r.replyActions, recipients: r.recipients,
    category: r.category, isSystem: r.isSystem,
  };
}

async function loadAll() {
  const now = Date.now();
  if (_cache && (now - _cache.at) < TTL_MS) return _cache.byKey;
  const byKey = new Map();
  try {
    const rows = await db.WhatsappAutomation.findAll();
    for (const r of rows) byKey.set(r.key, rowToObj(r));
  } catch (err) {
    console.warn('[WhatsAppAutomation] load falhou — usando fallback:', err?.message);
  }
  _cache = { at: now, byKey };
  return byKey;
}

export function invalidateAutomationCache() { _cache = null; }

/** Automação por chave (DB → fallback hardcode → null). */
export async function getByKey(key) {
  const byKey = await loadAll();
  return byKey.get(key) || FALLBACK[key] || null;
}

/** Automações habilitadas amarradas a um evento (ex: 'boleto.generated'). */
export async function getByEvent(event) {
  const byKey = await loadAll();
  const out = [];
  for (const a of byKey.values()) {
    if (a.enabled && a.triggerType === 'event' && a.triggerConfig?.event === event) out.push(a);
  }
  return out;
}

export default { getByKey, getByEvent, invalidateAutomationCache };
