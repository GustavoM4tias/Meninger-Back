// services/whatsapp/WhatsAppWebhookService.js
//
// Processa eventos recebidos no webhook da Cloud API:
//  - statuses: sent, delivered, read, failed (atualiza WhatsappMessage por meta_message_id)
//  - messages: mensagens recebidas (registra como direction='in' — base para atendimento)
//
// Também valida o payload via X-Hub-Signature-256 quando o app_secret está configurado.
//
// Política de opt-out: o cancelamento é feito SOMENTE pelo painel /settings/Account
// (não há atalho por palavra-chave no WhatsApp). Mensagens recebidas são apenas
// registradas em whatsapp_messages para o futuro fluxo de atendimento.

import crypto from 'crypto';
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import WhatsAppConfigService from './WhatsAppConfigService.js';
import WhatsAppService from './WhatsAppService.js';
import AlertReplyHandler from '../alerts/AlertReplyHandler.js';

const { WhatsappMessage, User } = db;

// Texto de auto-resposta para clientes externos (não-users) que respondem
// no número do sistema. Único objetivo: deixar claro que este é um canal de
// saída, evitar gerar expectativa de atendimento e direcionar pro canal certo.
const EXTERNAL_AUTOREPLY_TEXT =
    'Olá! 👋\n\n'
    + 'Este número é um canal *automático* do Office Menin, usado *somente para envio de comunicados* '
    + '(boletos, lembretes e atualizações relacionadas à sua reserva).\n\n'
    + '*Esta caixa não monitora respostas* — sua mensagem não será lida por um atendente. 🙏\n\n'
    + 'Para qualquer dúvida, por favor entre em contato com o *seu corretor responsável* '
    + 'ou com os canais oficiais da Menin em https://www.menin.com.br.\n\n'
    + 'Agradecemos a compreensão!';

// Janela de silêncio para auto-resposta — evita responder múltiplas vezes
// quando o cliente manda várias mensagens em sequência (loop de "ué, ninguém
// responde?" / nossa-auto / etc.).
const AUTOREPLY_COOLDOWN_HOURS = 24;

// ─── Verificação de assinatura ────────────────────────────────────────────────

/**
 * Valida assinatura HMAC-SHA256 do header X-Hub-Signature-256.
 * Se app_secret não estiver configurado, retorna true (skip — útil em dev).
 */
async function verifySignature(rawBody, signatureHeader) {
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.app_secret) return true;
    if (!signatureHeader) return false;

    const expected = `sha256=${crypto.createHmac('sha256', cfg.app_secret).update(rawBody).digest('hex')}`;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
    } catch {
        return false;
    }
}

/**
 * Verifica o handshake inicial do webhook (modo subscribe).
 * Retorna o challenge se válido, ou null se inválido.
 */
async function verifyHandshake({ mode, token, challenge }) {
    if (mode !== 'subscribe') return null;
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: true });
    if (!cfg?.webhook_verify_token) return null;
    return token === cfg.webhook_verify_token ? String(challenge) : null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const STATUS_MAP = {
    sent:      { status: 'sent',      tsField: 'sent_at' },
    delivered: { status: 'delivered', tsField: 'delivered_at' },
    read:      { status: 'read',      tsField: 'read_at' },
    failed:    { status: 'failed',    tsField: 'failed_at' },
};

async function handleStatusUpdate(s) {
    const wamid = s?.id;
    if (!wamid) return;

    const map = STATUS_MAP[s.status];
    if (!map) return;

    const row = await WhatsappMessage.findOne({ where: { meta_message_id: wamid } });
    if (!row) {
        // recebemos status de uma msg que não temos registro — só loga
        console.warn('[whatsapp/webhook] status para wamid desconhecido:', wamid, s.status);
        return;
    }

    const update = { status: map.status };
    update[map.tsField] = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();

    if (s.status === 'failed') {
        update.error_code = s.errors?.[0]?.code ? String(s.errors[0].code) : null;
        update.error_message = s.errors?.[0]?.title || s.errors?.[0]?.message || 'failed';
    }

    if (s.pricing?.category) {
        update.cost_category = s.pricing.category; // utility/marketing/authentication/service
    }

    await row.update(update);
}

async function handleIncomingMessage(m, fromPhone) {
    // tipos comuns: text, image, document, audio, video, button, interactive, reaction, sticker
    const type = m.type || 'unknown';
    let body = null;
    let mediaUrl = null;

    switch (type) {
        case 'text': body = m.text?.body || ''; break;
        case 'button': body = m.button?.text || ''; break;
        case 'interactive':
            body = m.interactive?.button_reply?.title
                || m.interactive?.list_reply?.title
                || JSON.stringify(m.interactive);
            break;
        default: body = m[type]?.caption || null;
    }

    // Tenta amarrar a um user pelo telefone (últimos 9 dígitos = celular sem DDI)
    let userId = null;
    if (fromPhone) {
        const u = await User.findOne({
            where: { whatsapp_phone: { [Op.like]: `%${fromPhone.slice(-9)}` } },
            attributes: ['id'],
        });
        userId = u?.id || null;
    }

    await WhatsappMessage.create({
        direction: 'in',
        user_id: userId,
        to_phone: '',                     // recebemos, então nosso número é destino — não relevante aqui
        from_phone: fromPhone,
        type: ['text','image','document','audio','video','interactive','button'].includes(type) ? type : 'unknown',
        body,
        media_url: mediaUrl,
        meta_message_id: m.id || null,
        status: 'received',
        raw_payload: m,
        sent_at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
    });

    // Encaminha pra fluxo de alertas APENAS se for resposta a uma mensagem específica
    // (recurso "Responder" do WhatsApp → context.id presente no payload).
    // Mensagens soltas no número do sistema não disparam relatório.
    const contextId = m?.context?.id || null;
    console.log(`[whatsapp/webhook] inbound type=${type} from=${fromPhone} body="${body}" contextId=${contextId || 'NONE'}`);
    // Payload completo pra debug — útil pra ver estrutura real do button/reply
    console.log(`[whatsapp/webhook] inbound full payload:`, JSON.stringify({
        id: m.id, type: m.type, button: m.button, text: m.text, interactive: m.interactive, context: m.context,
    }));
    try {
        await AlertReplyHandler.handleInbound({ fromPhone, body, contextId });
    } catch (err) {
        console.error('[whatsapp/webhook] AlertReplyHandler erro:', err?.message || err);
    }

    // Auto-resposta pra remetentes externos (não-users) — fire-and-forget.
    // Sem await pra não atrasar o ACK do webhook pra Meta.
    if (!userId && fromPhone) {
        maybeReplyToExternal(fromPhone).catch(err =>
            console.error('[whatsapp/webhook] auto-reply erro:', err?.message || err));
    }
}

/**
 * Responde ao remetente externo (cliente/contato sem user no Office) com
 * o texto padrão informando que é canal só de saída. Respeita cooldown de
 * 24h pra mesmo número evitando spam.
 */
async function maybeReplyToExternal(fromPhone) {
    // 1) cooldown — já respondemos esse número recentemente?
    const since = new Date(Date.now() - AUTOREPLY_COOLDOWN_HOURS * 3600 * 1000);
    const last = await WhatsappMessage.findOne({
        where: {
            direction: 'out',
            to_phone: fromPhone,
            type: 'text',
            // marca a auto-resposta com error_code='AUTOREPLY' (mesmo sendo sucesso)
            // pra distinguir de mensagens de texto normais no log
            error_code: 'AUTOREPLY',
            createdAt: { [Op.gte]: since },
        },
        order: [['createdAt', 'DESC']],
    });
    if (last) {
        console.log(`[whatsapp/webhook] auto-reply pulada — última pra ${fromPhone} em ${last.createdAt.toISOString()}`);
        return;
    }

    // 2) confirma config ativa (não quer responder durante dry_run nem com config off)
    const cfg = await WhatsAppConfigService.getConfig({ withSecrets: false });
    if (!cfg?.active || cfg.dry_run) {
        console.log(`[whatsapp/webhook] auto-reply pulada — config active=${cfg?.active} dry_run=${cfg?.dry_run}`);
        return;
    }

    // 3) envia o texto — funciona porque estamos dentro da janela 24h
    //    (a mensagem inbound do cliente acabou de chegar).
    try {
        const { id } = await WhatsAppService.sendText({
            to: fromPhone,
            body: EXTERNAL_AUTOREPLY_TEXT,
        });
        await WhatsappMessage.create({
            direction: 'out',
            to_phone: fromPhone,
            type: 'text',
            body: EXTERNAL_AUTOREPLY_TEXT,
            status: 'sent',
            meta_message_id: id,
            sent_at: new Date(),
            // marcador pra diferenciar essa resposta automática de envios manuais
            error_code: 'AUTOREPLY',
        });
        console.log(`[whatsapp/webhook] auto-reply enviada pra ${fromPhone} (wamid ${id})`);
    } catch (err) {
        console.error(`[whatsapp/webhook] auto-reply falhou pra ${fromPhone}: ${err?.message || err}`);
    }
}

/**
 * Processa o body inteiro do webhook (já parseado).
 * Estrutura típica:
 *   { object: 'whatsapp_business_account', entry: [ { changes: [ { value: { ... } } ] } ] }
 */
async function processPayload(body) {
    const entries = Array.isArray(body?.entry) ? body.entry : [];

    for (const entry of entries) {
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change?.value || {};

            // statuses
            if (Array.isArray(value.statuses)) {
                for (const s of value.statuses) {
                    try { await handleStatusUpdate(s); }
                    catch (e) { console.error('[whatsapp/webhook] status err:', e?.message); }
                }
            }

            // mensagens recebidas
            if (Array.isArray(value.messages)) {
                for (const m of value.messages) {
                    const fromPhone = m.from || value.contacts?.[0]?.wa_id || null;
                    try { await handleIncomingMessage(m, fromPhone); }
                    catch (e) { console.error('[whatsapp/webhook] inbound err:', e?.message); }
                }
            }
        }
    }
}

export default {
    verifySignature,
    verifyHandshake,
    processPayload,
};
