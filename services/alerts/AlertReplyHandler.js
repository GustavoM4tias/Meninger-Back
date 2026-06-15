// services/alerts/AlertReplyHandler.js
//
// Trata mensagens recebidas no webhook do WhatsApp pra resolver o fluxo de alerta.
//
// REGRA: a resposta SÓ é considerada se o user RESPONDER A MENSAGEM ESPECÍFICA
// do alerta no WhatsApp (recurso "Responder" — desliza pra esquerda na bolha).
// Quando isso acontece, a Meta envia `context.id = wamid` no payload inbound.
// Amarramos esse wamid ao alert_pending_reply pelo campo meta_message_id —
// não há ambiguidade entre múltiplos alertas no mesmo número.
//
// Mensagens SOLTAS (sem context, ou context apontando pra mensagem que não é
// alerta) são IGNORADAS pelo handler. O usuário pode conversar normalmente no
// número do sistema sem disparar o envio de relatórios.
//
// Palavras aceitas (case-insensitive, sem acentos):
//   SIM   → manda relatório completo (texto livre, grátis na janela 24h)
//   NÃO   → cancela o pending (state='cancelled')
//   *     → manda nudge pedindo SIM ou NÃO

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import WhatsAppService from '../whatsapp/WhatsAppService.js';
import WhatsAppConfigService from '../whatsapp/WhatsAppConfigService.js';

const { AlertPendingReply, WhatsappMessage } = db;

const YES_WORDS = new Set(['sim', 's', 'si', 'yes', 'y', 'ok', 'enviar', 'mostrar', 'detalhes', 'quero', 'confirmo', 'confirmar']);
const NO_WORDS  = new Set(['nao', 'n', 'no', 'cancelar', 'cancela', 'descartar', 'ignorar', 'pular']);

// Normaliza pra comparar (lowercase + sem acento + sem pontuação).
function normalize(text) {
    return String(text || '').trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove combining diacriticals
        .replace(/[^a-z0-9]/g, '');
}

// Tokeniza preservando palavras inteiras (separadas por espaço/quebra/pontuação).
function tokenize(text) {
    return String(text || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/**
 * Classifica resposta em yes/no/other com tolerância a ruído:
 *   1. Match exato da mensagem inteira (caso ideal: "SIM").
 *   2. Match da ÚLTIMA LINHA (caso comum: user usou Reply com citação).
 *   3. Match de QUALQUER TOKEN (caso "SIM por favor", "Pode ser SIM", etc).
 * "no" tem prioridade quando ambos aparecem (não enviar um relatório indevido).
 */
function classify(text) {
    if (!text) return 'other';

    // 1) mensagem inteira
    const whole = normalize(text);
    if (YES_WORDS.has(whole)) return 'yes';
    if (NO_WORDS.has(whole))  return 'no';

    // 2) última linha não vazia (típico após "Reply" do WhatsApp)
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && last !== text) {
        const n = normalize(last);
        if (YES_WORDS.has(n)) return 'yes';
        if (NO_WORDS.has(n))  return 'no';
    }

    // 3) qualquer token — NÃO ganha de SIM se ambos aparecerem
    const tokens = tokenize(text);
    const hasNo  = tokens.some(t => NO_WORDS.has(t));
    const hasYes = tokens.some(t => YES_WORDS.has(t));
    if (hasNo)  return 'no';
    if (hasYes) return 'yes';

    return 'other';
}

// ─── Envio de texto livre (free-form, dentro da janela 24h = grátis) ─────────

async function sendFreeText({ to, body, userId }) {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.active || cfg?.dry_run) {
        return WhatsappMessage.create({
            direction: 'out', user_id: userId, to_phone: to,
            type: 'text', body, status: 'dry_run',
        });
    }
    try {
        const { id } = await WhatsAppService.sendText({ to, body });
        return WhatsappMessage.create({
            direction: 'out', user_id: userId, to_phone: to,
            type: 'text', body, status: 'sent', meta_message_id: id, sent_at: new Date(),
        });
    } catch (err) {
        return WhatsappMessage.create({
            direction: 'out', user_id: userId, to_phone: to,
            type: 'text', body, status: 'failed',
            error_code: err.code || 'SEND_ERROR', error_message: err.message,
            failed_at: new Date(),
        });
    }
}

// ─── Handler principal ───────────────────────────────────────────────────────

/**
 * Chamado por WhatsAppWebhookService quando uma mensagem inbound chega.
 *
 * @param {object} args
 * @param {string} args.fromPhone     - E.164 do remetente
 * @param {string} args.body          - texto da mensagem
 * @param {string|null} args.contextId - wamid da mensagem que está sendo respondida
 *                                        (vem do payload Meta em messages[].context.id)
 *
 * @returns {Promise<boolean>} true se a mensagem foi consumida pelo fluxo de alerta
 */
async function handleInbound({ fromPhone, body, contextId }) {
    console.log(`[AlertReply] inbound from=${fromPhone} body="${body}" contextId=${contextId || 'NONE'}`);

    let pending = null;

    // 1) Caminho ideal: user usou "Responder" no WhatsApp (ou tocou botão Quick Reply)
    //    → context.id casa exato com o wamid do alerta. Sem ambiguidade.
    if (contextId) {
        pending = await AlertPendingReply.findOne({
            where: {
                meta_message_id: contextId,
                state: 'awaiting_reply',
                expires_at: { [Op.gt]: new Date() },
            },
        });
        console.log(`[AlertReply] lookup by contextId=${contextId} → ${pending ? 'pending#' + pending.id : 'NOT FOUND'}`);
    }

    // 2) Fallback: user mandou "SIM" direto sem usar Reply.
    //    Se houver EXATAMENTE 1 pending ativo pro telefone, usa esse.
    //    Se 0 → ignora (mensagem solta, talvez atendimento).
    //    Se 2+ → ignora também e responde pedindo pra usar Reply (evita confusão).
    if (!pending) {
        const digits = String(fromPhone || '').replace(/\D/g, '');
        if (!digits) return false;

        // Casamento por telefone TOLERANTE: normaliza o phone salvo pra dígitos
        // (o cadastro pode ter +, espaços ou traços) e tenta os últimos 9; se não
        // achar, tenta os últimos 8 — contorna o problema do 9º dígito do celular
        // BR (a Meta às vezes manda o wa_id com/sem o "9", divergindo do cadastro).
        // O guard "exatamente 1 pendente ativo" evita falso-positivo.
        const findByTail = (n) => AlertPendingReply.findAll({
            where: {
                state: 'awaiting_reply',
                expires_at: { [Op.gt]: new Date() },
                [Op.and]: [db.Sequelize.literal(
                    `regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%${digits.slice(-n)}'`
                )],
            },
            order: [['created_at', 'DESC']],
            limit: 3,
        });

        let candidates = await findByTail(9);
        if (candidates.length === 0 && digits.length >= 8) candidates = await findByTail(8);

        console.log(`[AlertReply] fallback by phone …${digits.slice(-9)} → ${candidates.length} candidatos`);

        if (candidates.length === 0) return false;
        if (candidates.length > 1) {
            // Múltiplos alertas pendentes — pede explicitação
            await sendFreeText({
                to: fromPhone,
                body: 'Você tem mais de um alerta pendente. Por favor, *responda diretamente* à mensagem do alerta que quer ver (deslize pra esquerda na bolha → Responder).',
                userId: candidates[0].user_id,
            });
            return true;
        }
        pending = candidates[0];
    }

    if (!pending) return false;

    const verdict = classify(body);
    console.log(`[AlertReply] pending#${pending.id} rule="${pending.rule_name}" verdict=${verdict}`);

    if (verdict === 'no') {
        await pending.update({ state: 'cancelled', confirmed_at: new Date() });
        await sendFreeText({
            to: fromPhone,
            body: `Tudo bem, descartei o relatório de *${pending.rule_name}*. Você ainda receberá os próximos disparos no horário programado.`,
            userId: pending.user_id,
        });
        return true;
    }

    if (verdict === 'yes') {
        const sent = await sendFreeText({ to: fromPhone, body: pending.report_payload, userId: pending.user_id });
        // Só marca como enviado se o envio REALMENTE saiu. Se falhou (ex: janela
        // 24h vencida, erro da Meta), mantém 'awaiting_reply' pra permitir nova
        // tentativa — evita o caso "confirmei, não chegou, e não dá pra repetir".
        if (sent?.status === 'failed') {
            console.warn(`[AlertReply] envio do relatório FALHOU (pending#${pending.id}) — mantém awaiting_reply p/ retry`);
            return true;
        }
        await pending.update({
            state: 'sent',
            confirmed_at: new Date(),
            report_sent_at: new Date(),
        });
        return true;
    }

    // 'other' — manda nudge sem mudar o estado
    await sendFreeText({
        to: fromPhone,
        body: `Recebi sua resposta sobre *${pending.rule_name}*, mas não entendi. Responda *SIM* para receber o relatório ou *NÃO* para descartar.`,
        userId: pending.user_id,
    });
    return true;
}

// ─── Limpeza periódica de expirados ──────────────────────────────────────────

async function cleanupExpired() {
    const [updated] = await AlertPendingReply.update(
        { state: 'expired' },
        {
            where: {
                state: 'awaiting_reply',
                expires_at: { [Op.lt]: new Date() },
            },
        }
    );
    return updated;
}

export default {
    handleInbound,
    cleanupExpired,
};
