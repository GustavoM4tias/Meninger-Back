// services/emeAtende/EmeAtendeLeadIntakeService.js
// Pipeline de entrada de leads da Eme Atende: normaliza → dedup por telefone →
// segmenta (eme_atende_flow_rules) → cria conversa → dispara opener.
// Toda transição vira eme_atende_events.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { normalizePhone, phoneSuffix } from './emeAtendePhone.js';
import EmeAtendeFlowService from './EmeAtendeFlowService.js';
import EmeAtendeMessenger from './EmeAtendeMessenger.js';

class IntakeError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * @param {object} data - { name, phone*, email, source, campaign, empreendimento, external_id, ...extras }
 * @param {object} meta - { apiKeyName }
 */
async function ingest(data = {}, { apiKeyName = null } = {}) {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new IntakeError('phone é obrigatório (formato BR com ou sem DDI).');
    if (phone.length < 10) throw new IntakeError('phone muito curto após normalização.');

    const known = ['name', 'phone', 'email', 'source', 'campaign', 'empreendimento', 'external_id'];
    const extras = Object.fromEntries(Object.entries(data).filter(([k]) => !known.includes(k)));

    // Dedup por sufixo (últimos 8 dígitos - resolve 9º dígito e formatações)
    const suffix = phoneSuffix(phone);
    const existing = await db.EmeAtendeLead.findOne({
        where: { phone: { [Op.like]: `%${suffix}` } },
        order: [['id', 'DESC']],
    });

    if (existing) {
        // opt-out é definitivo: nunca recontatar
        if (existing.status === 'opted_out') {
            await EmeAtendeMessenger.logEvent(existing.id, null, 'reentry_blocked_opted_out', { source: data.source, apiKeyName });
            throw new IntakeError('Lead fez opt-out - não será recontatado.', 409);
        }
        await existing.update({
            name: data.name || existing.name,
            email: data.email || existing.email,
            campaign: data.campaign || existing.campaign,
            empreendimento: data.empreendimento || existing.empreendimento,
            payload: { ...existing.payload, ...extras, last_reentry_source: data.source || null },
        });
        const activeConv = await db.EmeAtendeConversation.findOne({
            where: { lead_id: existing.id, state: { [Op.ne]: 'closed' } },
            order: [['id', 'DESC']],
        });
        await EmeAtendeMessenger.logEvent(existing.id, activeConv?.id || null, 'lead_reentry', { source: data.source, apiKeyName });
        if (activeConv) return { lead: existing, conversation: activeConv, reentry: true, reopened: false };

        // conversa anterior fechada → reabre com novo opener
        const { flow } = await EmeAtendeFlowService.matchFlow(existing);
        const conversation = await db.EmeAtendeConversation.create({
            lead_id: existing.id, flow_id: flow?.id || null, phone: existing.phone, state: 'bot',
        });
        await existing.update({ flow_id: flow?.id || null, status: 'opened' });
        await EmeAtendeMessenger.logEvent(existing.id, conversation.id, 'conversation_reopened', { flow: flow?.name });
        if (flow) await EmeAtendeMessenger.sendOpener({ lead: existing, conversation, flow });
        return { lead: existing, conversation, reentry: true, reopened: true };
    }

    // Lead novo
    const lead = await db.EmeAtendeLead.create({
        name: data.name || null,
        phone,
        email: data.email || null,
        source: data.source || apiKeyName || 'api',
        campaign: data.campaign || null,
        empreendimento: data.empreendimento || null,
        external_id: data.external_id ? String(data.external_id) : null,
        payload: extras,
        status: 'received',
    });
    await EmeAtendeMessenger.logEvent(lead.id, null, 'lead_received', { source: lead.source, apiKeyName });

    const { flow, matchedRule } = await EmeAtendeFlowService.matchFlow(lead);
    const conversation = await db.EmeAtendeConversation.create({
        lead_id: lead.id, flow_id: flow?.id || null, phone, state: 'bot',
    });
    await lead.update({ flow_id: flow?.id || null });
    await EmeAtendeMessenger.logEvent(lead.id, conversation.id, 'flow_assigned', {
        flow: flow?.name || null,
        rule: matchedRule ? `${matchedRule.field} ${matchedRule.operator} "${matchedRule.value}"` : 'default',
    });

    if (flow) {
        await EmeAtendeMessenger.sendOpener({ lead, conversation, flow });
        await lead.update({ status: 'opened' });
    }
    return { lead, conversation, reentry: false };
}

export default { ingest, IntakeError };
