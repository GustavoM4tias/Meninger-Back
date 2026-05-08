// controllers/whatsapp/whatsappWebhookController.js
//
// Endpoints públicos para o webhook da Meta:
//   GET  /api/whatsapp/webhook  -> handshake (verificação inicial)
//   POST /api/whatsapp/webhook  -> recebe statuses e mensagens
//
// Observação: o handler POST precisa do raw body para validar a assinatura HMAC.
// A montagem em routes usa express.raw() para esse path específico.

import WhatsAppWebhookService from '../../services/whatsapp/WhatsAppWebhookService.js';

/** GET — handshake */
export const verify = async (req, res) => {
    try {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        const ok = await WhatsAppWebhookService.verifyHandshake({ mode, token, challenge });
        if (ok) return res.status(200).send(ok);
        return res.status(403).send('forbidden');
    } catch (err) {
        console.error('[whatsapp/webhook/verify]', err);
        return res.status(500).send('error');
    }
};

/** POST — eventos */
export const receive = async (req, res) => {
    try {
        // req.body é Buffer (express.raw) — precisamos do raw para HMAC
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
        const signature = req.header('x-hub-signature-256') || '';

        const valid = await WhatsAppWebhookService.verifySignature(raw, signature);
        if (!valid) {
            console.warn('[whatsapp/webhook] assinatura inválida');
            return res.status(401).send('invalid signature');
        }

        let payload;
        try {
            payload = JSON.parse(raw.toString('utf8'));
        } catch {
            return res.status(400).send('invalid json');
        }

        // ACK rápido — Meta dá retry se demorar
        res.status(200).send('ok');

        // processa em background
        WhatsAppWebhookService.processPayload(payload)
            .catch(err => console.error('[whatsapp/webhook/process]', err?.message || err));
    } catch (err) {
        console.error('[whatsapp/webhook/receive]', err);
        if (!res.headersSent) res.status(500).send('error');
    }
};
