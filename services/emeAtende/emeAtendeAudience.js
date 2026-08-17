// services/emeAtende/emeAtendeAudience.js
//
// Decide QUEM a Eme Atende pode atender. É a trava de contato frio.
//
// Antes desta trava, com active=true qualquer externo que escrevesse no número
// virava lead e caía no atendimento comercial da IA — inclusive o titular que
// recebeu boleto e responde "não consegui pagar". Agora só conversa com a IA
// quem JÁ É lead da Eme Atende; o resto continua na auto-resposta de canal só
// de saída do Office (comportamento atual, intacto).
//
// Modo teste: com test_mode=true, só os números de test_phones são atendidos
// (e esses não precisam ser lead) — é assim que se testa com número fake em
// produção sem risco de atender cliente de verdade.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import EmeAtendeSettingsService from './EmeAtendeSettingsService.js';
import { phoneSuffix, samePhone } from './emeAtendePhone.js';

/** O número está na lista de teste? */
export function isTestPhone(phone, testPhones = []) {
    return testPhones.some(p => samePhone(p, phone));
}

/**
 * Lead conhecido = existe em eme_atende_leads e NÃO fez opt-out.
 * Opt-out é definitivo: quem pediu pra parar volta pra auto-resposta do Office,
 * nunca pro atendimento.
 */
export async function findKnownLead(phone) {
    const suffix = phoneSuffix(phone);
    if (!suffix) return null;
    const candidates = await db.EmeAtendeLead.findAll({
        where: { phone: { [Op.like]: `%${suffix}` } },
        order: [['id', 'DESC']],
        limit: 10,
    });
    return candidates.find(l => samePhone(l.phone, phone) && l.status !== 'opted_out') || null;
}

/**
 * A Eme Atende deve tratar a mensagem deste número?
 * @returns {Promise<{ handle: boolean, reason: string }>} reason entra no log
 *          pra ficar claro POR QUE uma mensagem não virou atendimento.
 */
export async function shouldHandle(phone) {
    if (!phone) return { handle: false, reason: 'sem telefone' };

    const cfg = await EmeAtendeSettingsService.getConfig();
    if (!cfg.active) return { handle: false, reason: 'eme atende inativa' };

    if (cfg.test_mode) {
        return isTestPhone(phone, cfg.test_phones)
            ? { handle: true, reason: 'modo teste: número na lista' }
            : { handle: false, reason: 'modo teste: número fora da lista' };
    }

    const lead = await findKnownLead(phone);
    if (lead) return { handle: true, reason: `lead #${lead.id} (${lead.status})` };
    return { handle: false, reason: 'não é lead da Eme Atende (contato frio)' };
}

export default { shouldHandle, findKnownLead, isTestPhone };
