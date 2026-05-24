// controllers/marketing/metaWebhookController.js
//
// Webhook do Meta Lead Ads:
//  - GET  /api/marketing/webhook/meta → handshake de assinatura (hub.challenge)
//  - POST /api/marketing/webhook/meta → eventos 'leadgen'
//
// O POST recebe o body como Buffer (raw) para validar o HMAC. ACK rápido (200)
// e processamento em background — o Meta reenvia se a resposta demorar.

import { verifySignature, verifyHandshake, processLeadgenPayload } from '../../services/marketing/MetaLeadAdsService.js';

export function verifyMetaWebhook(req, res) {
    const challenge = verifyHandshake({
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

export function receiveMetaWebhook(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

    if (!verifySignature(rawBody, req.headers['x-hub-signature-256'])) {
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
