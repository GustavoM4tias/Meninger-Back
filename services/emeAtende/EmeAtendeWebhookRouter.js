// services/emeAtende/EmeAtendeWebhookRouter.js
//
// NÚMERO COMPARTILHADO: o mesmo telefone atende notificações internas (Office)
// e leads externos (Eme Atende). O webhook da Meta é um só, então este router decide
// o destino de cada evento:
//
//   - messages  → por REMETENTE: user interno (telefone do perfil, ou o
//                 whatsapp_phone legado, casando por DDD + assinante) → Office
//                 (fluxo de alertas/SIM intacto);
//                 externo que JÁ É lead da Eme Atende → atendimento IA;
//                 externo desconhecido → Office (auto-resposta de canal só de
//                 saída). Ver emeAtendeAudience.js — é a trava de contato frio.
//   - statuses  → pelo DONO do wamid: se whatsapp_messages conhece → Office;
//                 senão → Eme Atende (eme_atende_messages). Evita warn de wamid desconhecido
//                 dos dois lados.
//   - demais    → Office.
//
// Gate: eme_atende_settings.active=false (default) → TUDO pro Office, comportamento
// 100% idêntico ao atual. Qualquer erro aqui → fail-open pro Office.

import db from '../../models/sequelize/index.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';
import EmeAtendeAudience from './emeAtendeAudience.js';
import { findUserByPhone } from '../whatsapp/whatsappPhone.js';

async function isInternalUser(fromPhone) {
    // Olha o telefone do PERFIL e o whatsapp_phone legado. O sufixo no SQL só
    // pré-filtra; quem decide é samePhone (DDD + assinante). Ver whatsappPhone.js.
    return !!(await findUserByPhone(fromPhone, { attributes: ['id'] }));
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

            // messages → interno, lead conhecido, ou nenhum dos dois
            if (Array.isArray(value.messages)) {
                const off = [];
                const eme = [];
                for (const m of value.messages) {
                    const from = m?.from || value.contacts?.[0]?.wa_id || null;
                    // Número em teste ganha do check de interno: sem isso quem
                    // administra a Eme não consegue testar com o próprio celular.
                    const emTeste = await EmeAtendeAudience.isTestOverride(from);
                    if (!emTeste && await isInternalUser(from)) { off.push(m); continue; }
                    // Externo: só vai pra Eme Atende se for lead conhecido (ou
                    // estiver na lista de teste). Contato frio segue no Office e
                    // recebe a auto-resposta de canal só de saída.
                    const { handle, reason } = await EmeAtendeAudience.shouldHandle(from);
                    if (handle) eme.push(m);
                    else {
                        console.log(`[eme-atende/router] ${from} fica no Office — ${reason}`);
                        off.push(m);
                    }
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
