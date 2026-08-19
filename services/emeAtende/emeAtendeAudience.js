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
 * Modo teste tem precedência sobre "é usuário interno".
 *
 * O roteador manda usuário do Office pro fluxo interno ANTES de olhar público-
 * alvo - correto no dia a dia, mas inviabilizava o teste: quem administra a Eme
 * é funcionário, e o número dele nunca chegaria na IA. Com test_mode ligado, o
 * número que está na lista vai pra Eme Atende mesmo sendo interno.
 *
 * Custo consciente: enquanto o modo teste estiver ligado, as mensagens DESSE
 * número não caem no fluxo interno do Office (alertas, SIM). É o que se espera
 * de um número em teste, e some quando o modo teste é desligado.
 */
export async function isTestOverride(phone) {
    if (!phone) return false;
    const cfg = await EmeAtendeSettingsService.getConfig();
    return !!(cfg.active && cfg.test_mode && isTestPhone(phone, cfg.test_phones));
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

export default { shouldHandle, findKnownLead, isTestPhone, isTestOverride };
