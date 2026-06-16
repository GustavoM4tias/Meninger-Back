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
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    console.log(`[whatsapp/webhook] GET hit mode=${mode} token=${token ? '(presente)' : '(vazio)'} challenge=${challenge || '-'}`);
    try {
        const ok = await WhatsAppWebhookService.verifyHandshake({ mode, token, challenge });
        if (ok) {
            console.log('[whatsapp/webhook] handshake OK');
            return res.status(200).send(ok);
        }
        console.warn('[whatsapp/webhook] handshake REJEITADO — verify_token não bate ou mode não é subscribe');
        return res.status(403).send('forbidden');
    } catch (err) {
        console.error('[whatsapp/webhook/verify]', err);
        return res.status(500).send('error');
    }
};

/** POST — eventos */
export const receive = async (req, res) => {
    // Log de TODA chamada — útil pra confirmar que a Meta está alcançando o webhook.
    console.log(`[whatsapp/webhook] HIT user-agent="${req.header('user-agent') || '-'}" sig=${req.header('x-hub-signature-256') ? 'present' : 'MISSING'}`);

    try {
        // req.body é Buffer (express.raw) — precisamos do raw para HMAC
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
        const signature = req.header('x-hub-signature-256') || '';

        const valid = await WhatsAppWebhookService.verifySignature(raw, signature);
        if (!valid) {
            // Assinatura inválida quase sempre = app_secret desatualizado (NÃO ataque).
            // DESCARTAR aqui fazia o sistema perder o "SIM" do usuário em silêncio.
            // Num webhook INTERNO o risco é baixo: o relatório só é enviado pro telefone
            // do próprio usuário que tem um pendente ativo, no servidor. Então logamos
            // alto e PROCESSAMOS mesmo assim (cada inbound vira linha 'in' visível na aba
            // Mensagens). Para reativar a verificação estrita, corrija o app_secret em
            // /settings/whatsapp (Config) — aí as assinaturas voltam a bater.
            console.warn('[whatsapp/webhook] ⚠️ ASSINATURA INVÁLIDA — processando mesmo assim. Atualize o app_secret em /settings/whatsapp para reativar a verificação.');
        }

        let payload;
        try {
            payload = JSON.parse(raw.toString('utf8'));
        } catch {
            return res.status(400).send('invalid json');
        }

        console.log(`[whatsapp/webhook] payload object=${payload?.object} entries=${(payload?.entry || []).length}`);

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
