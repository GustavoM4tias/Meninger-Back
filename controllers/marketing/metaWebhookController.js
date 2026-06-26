// controllers/marketing/metaWebhookController.js
//
// Webhook do Meta Lead Ads:
//  - GET  /api/marketing/webhook/meta → handshake de assinatura (hub.challenge)
//  - POST /api/marketing/webhook/meta → eventos 'leadgen'
//
// O POST recebe o body como Buffer (raw) para validar o HMAC. ACK rápido (200)
// e processamento em background — o Meta reenvia se a resposta demorar.

import { verifySignature, verifyHandshake, processLeadgenPayload } from '../../services/marketing/MetaLeadAdsService.js';
import db from '../../models/sequelize/index.js';
import NotificationService from '../../services/notification/NotificationService.js';
import { NotificationType } from '../../services/notification/notificationTypes.js';

// Alerta admin (throttle de 1h) quando o webhook passa a rejeitar por assinatura
// inválida — quase sempre App Secret dessincronizado. Evita o cenário de
// descobrir só dias depois que os leads pararam de entrar.
let _lastSigAlertAt = 0;
const SIG_ALERT_THROTTLE_MS = 60 * 60 * 1000;

async function alertSignatureRejected() {
    const now = Date.now();
    if (now - _lastSigAlertAt < SIG_ALERT_THROTTLE_MS) return;
    _lastSigAlertAt = now;
    try {
        const admins = await db.User.findAll({ where: { role: 'admin', status: true }, attributes: ['id'] });
        const userIds = admins.map(u => u.id);
        if (!userIds.length) return;
        await NotificationService.notify({
            type: NotificationType.LEAD_WEBHOOK_REJECTED,
            recipients: { users: userIds },
            title: 'Webhook de leads do Meta rejeitando',
            body: 'O webhook de leads do Meta está rejeitando eventos por assinatura inválida (App Secret ausente ou dessincronizado). Novos leads não estão entrando. Atualize o App Secret em Configurações › Meta (App).',
            link: '/settings/meta',
            importance: 9,
        });
        console.warn('🔔 [marketing-capture] alerta enviado: webhook Meta rejeitando por assinatura.');
    } catch (e) {
        console.error('[marketing-capture] falha ao alertar assinatura inválida:', e.message);
    }
}

export async function verifyMetaWebhook(req, res) {
    const challenge = await verifyHandshake({
        mode: req.query['hub.mode'],
        token: req.query['hub.verify_token'],
        challenge: req.query['hub.challenge'],
    });
    if (challenge === null) {
        console.warn('⚠️  [marketing-capture] handshake do webhook Meta recusado.');
        return res.sendStatus(403);
    }
    return res.status(200).send(challenge);
}

export async function receiveMetaWebhook(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    if (!(await verifySignature(rawBody, req.headers['x-hub-signature-256']))) {
        alertSignatureRejected().catch(() => {});   // fire-and-forget, não bloqueia o retorno
        return res.sendStatus(403);
    }

    // ACK imediato — o processamento (Graph API + captura) roda em background.
    res.sendStatus(200);

    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
        console.error('❌ [marketing-capture] webhook Meta: body não é JSON válido.');
        return;
    }

    processLeadgenPayload(payload).catch(err => {
        console.error(`❌ [marketing-capture] webhook Meta: erro no processamento: ${err.message}`);
    });
}

export default { verifyMetaWebhook, receiveMetaWebhook };
