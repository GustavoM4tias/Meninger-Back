// services/whatsapp/whatsappPhone.js
//
// Telefone do usuário no WhatsApp — FONTE ÚNICA.
//
// Regra (2026-08-17): o número do WhatsApp é o telefone do PERFIL (`users.phone`).
// Não existe mais cadastro separado nem opt-in — quem está no Office recebe pelo
// canal, do mesmo jeito que recebe por e-mail e pelo sino. A coluna legada
// `users.whatsapp_phone` continua sendo lida como FALLBACK, só pra não derrubar
// a entrega de quem preencheu o opt-in antes de ter telefone no perfil
// (`lib/ensureUserPhoneBackfill.js` consolida isso no boot).
//
// Normalização e comparação nasceram em services/emeAtende/emeAtendePhone.js e
// foram promovidas pra cá porque agora servem os dois lados (Office + Eme Atende).

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

/** Dígitos no formato da Cloud API (E.164 sem "+"). Assume Brasil quando falta DDI. */
export function normalizePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^\d]/g, '');
    if (!digits) return null;
    digits = digits.replace(/^0+/, '');
    // 10-11 dígitos = DDD + número sem DDI → assume Brasil
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    return digits;
}

export function phoneSuffix(phone) {
    const n = normalizePhone(phone);
    return n ? n.slice(-8) : null;
}

// Chave canônica p/ COMPARAÇÃO: DDD + últimos 8 do assinante (ignora DDI 55 e o
// 9º dígito móvel). O sufixo puro de 8 dígitos colide entre DDDs diferentes —
// risco de rotear lead como interno ou mesclar conversas de leads distintos.
export function phoneKey(phone) {
    const n = normalizePhone(phone);
    if (!n) return null;
    const rest = n.startsWith('55') && n.length >= 12 ? n.slice(2) : n;
    if (rest.length < 10) return rest; // sem DDD identificável — usa o que tem
    return `${rest.slice(0, 2)}${rest.slice(-8)}`;
}

// true quando os dois números são o MESMO assinante. Se algum dos lados foi
// salvo sem DDD (chave < 10 dígitos), cai no sufixo de 8 — compatível com
// cadastros antigos; quando ambos têm DDD, a comparação é estrita.
export function samePhone(a, b) {
    const ka = phoneKey(a);
    const kb = phoneKey(b);
    if (!ka || !kb) return false;
    if (ka.length >= 10 && kb.length >= 10) return ka === kb;
    return ka.slice(-8) === kb.slice(-8);
}

// Colunas que TODA consulta de destinatário precisa trazer pra `resolveUserPhone`
// funcionar. Esquecer uma delas faz o usuário parecer "sem telefone".
export const USER_PHONE_ATTRS = ['phone', 'whatsapp_phone'];

/**
 * Número de WhatsApp do usuário, já normalizado (E.164 sem "+").
 * Perfil manda; `whatsapp_phone` é só resquício do opt-in antigo.
 * @returns {string|null} null = usuário não tem telefone cadastrado.
 */
export function resolveUserPhone(user) {
    return normalizePhone(user?.phone) || normalizePhone(user?.whatsapp_phone) || null;
}

/** Atalho de legibilidade: o usuário é alcançável por WhatsApp? */
export function canReceiveWhatsApp(user) {
    return !!resolveUserPhone(user);
}

/**
 * Acha o usuário interno dono de um número (inbound do webhook).
 * Olha as DUAS colunas: o sufixo no SQL só pré-filtra candidatos; quem decide é
 * `samePhone` (DDD + assinante), porque sufixo puro colide entre DDDs.
 *
 * @returns {Promise<object|null>}
 */
export async function findUserByPhone(phone, { attributes = null } = {}) {
    const suffix = phoneSuffix(phone);
    if (!suffix) return null;

    const attrs = attributes
        ? [...new Set([...attributes, ...USER_PHONE_ATTRS, 'id'])]
        : ['id', 'username', 'email', ...USER_PHONE_ATTRS];

    const candidates = await db.User.findAll({
        where: {
            [Op.or]: [
                { phone: { [Op.like]: `%${suffix}` } },
                { whatsapp_phone: { [Op.like]: `%${suffix}` } },
            ],
        },
        attributes: attrs,
        limit: 20,
    });

    return candidates.find(u =>
        samePhone(u.phone, phone) || samePhone(u.whatsapp_phone, phone)) || null;
}

export default {
    normalizePhone,
    phoneSuffix,
    phoneKey,
    samePhone,
    resolveUserPhone,
    canReceiveWhatsApp,
    findUserByPhone,
    USER_PHONE_ATTRS,
};
