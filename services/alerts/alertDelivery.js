// services/alerts/alertDelivery.js
//
// Preferência de ENTREGA do alerta no WhatsApp: em que formato o relatório
// chega e se a Eme pergunta antes de mandar.
//
//   { format: 'pdf' | 'text' | 'xlsx', ask_first: boolean }
//
// Cascata (regra da casa, "tudo configurável"):
//   alert_rules.delivery (por regra)
//     → whatsapp_automations['alert_generic'].settings.delivery (padrão global, portal)
//       → DELIVERY_PADRAO (fallback de código)
//
// Módulo puro: sem banco, testável.

export const DELIVERY_FORMATS = ['pdf', 'text', 'xlsx'];

export const DELIVERY_PADRAO = Object.freeze({ format: 'pdf', ask_first: false });

export const DELIVERY_LABELS = {
    pdf:  'PDF em anexo',
    text: 'Só o resumo em texto',
    xlsx: 'Planilha (Excel)',
};

/**
 * Valida/normaliza um objeto vindo da tela, da Eme ou da API.
 * Devolve null quando não há nada válido (= herda o padrão).
 */
export function normalizarDelivery(input) {
    if (!input || typeof input !== 'object') return null;
    const out = {};
    if (typeof input.format === 'string' && DELIVERY_FORMATS.includes(input.format)) out.format = input.format;
    if (input.ask_first !== undefined && input.ask_first !== null) out.ask_first = !!input.ask_first;
    return Object.keys(out).length ? out : null;
}

/**
 * Preferência efetiva de uma regra.
 * @param {object|null} ruleDelivery      alert_rules.delivery
 * @param {object|null} globalDelivery    automação alert_generic → settings.delivery
 */
export function resolverDelivery(ruleDelivery, globalDelivery) {
    return {
        ...DELIVERY_PADRAO,
        ...(normalizarDelivery(globalDelivery) || {}),
        ...(normalizarDelivery(ruleDelivery) || {}),
    };
}

export default { DELIVERY_FORMATS, DELIVERY_PADRAO, DELIVERY_LABELS, normalizarDelivery, resolverDelivery };
