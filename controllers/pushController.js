// controllers/pushController.js
//
// Inscrição de aparelhos no push. Tudo autenticado: a inscrição pertence ao
// usuário do token, nunca a um id vindo do corpo da requisição.

import PushService from '../services/notification/PushService.js';

export async function vapidKey(req, res) {
    try {
        const keys = await PushService.getVapidKeys();
        if (!keys) {
            return res.status(503).json({ message: 'Push ainda não configurado no servidor.' });
        }
        // Só a pública sai daqui. A privada nunca deixa o backend.
        return res.json({ publicKey: keys.publicKey });
    } catch (err) {
        console.error('[push] vapidKey:', err?.message || err);
        return res.status(500).json({ message: 'Falha ao obter a chave de push.' });
    }
}

export async function subscribe(req, res) {
    try {
        const { subscription, userAgent, standalone } = req.body || {};
        await PushService.saveSubscription(req.user.id, { subscription, userAgent, standalone });
        return res.status(201).json({ ok: true });
    } catch (err) {
        const status = err?.status || 500;
        if (status !== 400) console.error('[push] subscribe:', err?.message || err);
        return res.status(status).json({ message: err?.message || 'Falha ao registrar o aparelho.' });
    }
}

export async function unsubscribe(req, res) {
    try {
        const { endpoint } = req.body || {};
        const removed = await PushService.removeSubscription(req.user.id, endpoint);
        return res.json({ ok: true, removed });
    } catch (err) {
        console.error('[push] unsubscribe:', err?.message || err);
        return res.status(500).json({ message: 'Falha ao remover o aparelho.' });
    }
}

export async function listDevices(req, res) {
    try {
        return res.json(await PushService.listForUser(req.user.id));
    } catch (err) {
        console.error('[push] listDevices:', err?.message || err);
        return res.status(500).json({ message: 'Falha ao listar aparelhos.' });
    }
}

export async function removeDevice(req, res) {
    try {
        const removed = await PushService.removeDevice(req.user.id, Number(req.params.id));
        if (!removed) return res.status(404).json({ message: 'Aparelho não encontrado.' });
        return res.json({ ok: true });
    } catch (err) {
        console.error('[push] removeDevice:', err?.message || err);
        return res.status(500).json({ message: 'Falha ao remover o aparelho.' });
    }
}

/** Dispara um push de teste para o próprio usuário — usado na tela /instalar. */
export async function test(req, res) {
    try {
        const result = await PushService.sendToUser(req.user.id, {
            title: 'Menin Office',
            body: 'Notificações ativadas neste aparelho.',
            link: '/instalar',
            tag: 'push-teste',
        });
        return res.json(result);
    } catch (err) {
        console.error('[push] test:', err?.message || err);
        return res.status(500).json({ message: 'Falha ao enviar o teste.' });
    }
}
