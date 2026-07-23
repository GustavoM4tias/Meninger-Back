// services/whatsapp/WhatsAppWindowService.js
//
// Janela de atendimento de 24h da Cloud API: abre/renova a cada mensagem
// RECEBIDA do contato. Dentro dela, mensagens de serviço (texto/mídia livre)
// são GRATUITAS — template pago só é necessário fora da janela.
//
// Fonte da verdade: as próprias rows direction='in' de whatsapp_messages
// (todo inbound do webhook é persistido lá). Sem tabela nova.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Margem de segurança: não arrisca enviar texto livre com a janela fechando
// em trânsito (daria erro 131047 e o cliente ficaria sem a mensagem).
const SAFETY_MS = 5 * 60 * 1000;

/**
 * Estado da janela de serviço para um telefone.
 * @returns {Promise<{open:boolean, lastInboundAt:Date|null, expiresAt:Date|null}>}
 */
export async function getServiceWindow(phone) {
    const digits = String(phone || '').replace(/[^\d]/g, '');
    if (digits.length < 8) return { open: false, lastInboundAt: null, expiresAt: null };
    const suffix = digits.slice(-9); // celular BR sem DDI — mesmo match do inbound
    const last = await db.WhatsappMessage.findOne({
        where: {
            direction: 'in',
            from_phone: { [Op.like]: `%${suffix}` },
            created_at: { [Op.gte]: new Date(Date.now() - WINDOW_MS) },
        },
        order: [['created_at', 'DESC']],
        attributes: ['id', 'created_at'],
    });
    if (!last) return { open: false, lastInboundAt: null, expiresAt: null };
    const expiresAt = new Date(new Date(last.created_at).getTime() + WINDOW_MS);
    const open = expiresAt.getTime() - Date.now() > SAFETY_MS;
    return { open, lastInboundAt: last.created_at, expiresAt };
}

export default { getServiceWindow };
