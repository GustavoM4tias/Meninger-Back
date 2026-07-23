// services/emeAtende/EmeAtendeWebhookRouter.js
//
// NÚMERO COMPARTILHADO: o mesmo telefone atende notificações internas (Office)
// e leads externos (Eme Atende). O webhook da Meta é um só, então este router decide
// o destino de cada evento:
//
//   - messages  → por REMETENTE: user interno (users.whatsapp_phone casa por
//                 sufixo 9→8 dígitos) → Office (fluxo de alertas/SIM intacto);
//                 qualquer outro → Eme Atende (que substitui a auto-resposta de
//                 "canal só de saída" pelo atendimento IA).
//   - statuses  → pelo DONO do wamid: se whatsapp_messages conhece → Office;
//                 senão → Eme Atende (eme_atende_messages). Evita warn de wamid desconhecido
//                 dos dois lados.
//   - demais    → Office.
//
// Gate: eme_atende_settings.active=false (default) → TUDO pro Office, comportamento
// 100% idêntico ao atual. Qualquer erro aqui → fail-open pro Office.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';
import { phoneSuffix, samePhone } from './emeAtendePhone.js';

async function isInternalUser(fromPhone) {
    const suffix = phoneSuffix(fromPhone);
    if (!suffix) return false;
    // Sufixo de 8 no SQL só pré-filtra candidatos; a decisão é samePhone
    // (DDD + assinante) — sufixo puro colide entre DDDs diferentes.
    const candidates = await db.User.findAll({
        where: { whatsapp_phone: { [Op.like]: `%${suffix}` } },
        attributes: ['id', 'whatsapp_phone'],
    });
    return candidates.some(u => samePhone(u.whatsapp_phone, fromPhone));
}

async function officeOwnsWamid(wamid) {
    if (!wamid) return true; // sem wamid não tem como casar - deixa no Office
    const row = await db.WhatsappMessage.findOne({
        where: { meta_message_id: wamid },
        attributes: ['id'],
    });
    return !!row;
}

/**
 * Divide o payload do webhook entre Office e Eme Atende.
 * @returns {Promise<{officePayload: object|null, emeAtendePayload: object|null}>}
 */
async function route(payload) {
    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active || !Array.isArray(payload?.entry)) {
        return { officePayload: payload, emeAtendePayload: null };
    }

    const officeEntries = [];
    const emeAtendeEntries = [];

    for (const entry of payload.entry) {
        const officeChanges = [];
        const emeAtendeChanges = [];

        for (const change of (Array.isArray(entry.changes) ? entry.changes : [])) {
            const value = change?.value || {};
            const officeValue = { ...value };
            const emeAtendeValue = { ...value };
            let hasOffice = false;
            let hasEmeAtende = false;

            // statuses → dono do wamid
            if (Array.isArray(value.statuses)) {
                const off = [];
                const eme = [];
                for (const s of value.statuses) {
                    if (await officeOwnsWamid(s?.id)) off.push(s);
                    else eme.push(s);
                }
                officeValue.statuses = off;
                emeAtendeValue.statuses = eme;
                if (off.length) hasOffice = true;
                if (eme.length) hasEmeAtende = true;
                if (!off.length) delete officeValue.statuses;
                if (!eme.length) delete emeAtendeValue.statuses;
            }

            // messages → remetente interno vs externo
            if (Array.isArray(value.messages)) {
                const off = [];
                const eme = [];
                for (const m of value.messages) {
                    const from = m?.from || value.contacts?.[0]?.wa_id || null;
                    if (await isInternalUser(from)) off.push(m);
                    else eme.push(m);
                }
                officeValue.messages = off;
                emeAtendeValue.messages = eme;
                if (off.length) hasOffice = true;
                if (eme.length) hasEmeAtende = true;
                if (!off.length) delete officeValue.messages;
                if (!eme.length) delete emeAtendeValue.messages;
            }

            // change sem statuses/messages (errors, template updates...) → Office
            if (!Array.isArray(value.statuses) && !Array.isArray(value.messages)) {
                hasOffice = true;
            }

            if (hasOffice) officeChanges.push({ ...change, value: officeValue });
            if (hasEmeAtende) emeAtendeChanges.push({ ...change, value: emeAtendeValue });
        }

        if (officeChanges.length) officeEntries.push({ ...entry, changes: officeChanges });
        if (emeAtendeChanges.length) emeAtendeEntries.push({ ...entry, changes: emeAtendeChanges });
    }

    return {
        officePayload: officeEntries.length ? { ...payload, entry: officeEntries } : null,
        emeAtendePayload: emeAtendeEntries.length ? { ...payload, entry: emeAtendeEntries } : null,
    };
}

export default { route, isInternalUser };
