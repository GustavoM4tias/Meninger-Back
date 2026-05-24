// services/marketing/leadEventLog.js
//
// Helper único para gravar eventos na trilha de auditoria de um inbound_lead.
// NUNCA lança — uma falha ao registrar evento não pode quebrar o pipeline de
// captação. É o registro durável que a tela de detalhe mostra como timeline.

import db from '../../models/sequelize/index.js';

/**
 * @param {object}  p
 * @param {string}  p.leadId      UUID do inbound_lead
 * @param {string}  p.type        event_type (received, routed, dispatch_attempt, ...)
 * @param {string} [p.statusFrom] status anterior
 * @param {string} [p.statusTo]   status novo
 * @param {string} [p.message]    descrição legível
 * @param {object} [p.detail]     payload estruturado (JSONB)
 * @param {string} [p.actor]      'system' | 'scheduler' | 'user:<id>'
 */
export async function recordLeadEvent({
    leadId,
    type,
    statusFrom = null,
    statusTo = null,
    message = null,
    detail = null,
    actor = 'system',
}) {
    try {
        await db.InboundLeadEvent.create({
            inbound_lead_id: leadId,
            event_type: type,
            status_from: statusFrom,
            status_to: statusTo,
            message,
            detail,
            actor,
        });
    } catch (err) {
        console.error(`❌ [marketing-capture] falha ao gravar evento "${type}" do lead ${leadId}: ${err.message}`);
    }
}

export default { recordLeadEvent };
