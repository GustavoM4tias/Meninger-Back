// services/notification/PushService.js
//
// Web Push (VAPID) — notificação nativa no celular e no desktop.
//
// Canal adicional do NotificationService, que fica ao lado de in-app, e-mail e
// WhatsApp. A regra é simples e de propósito: quem recebe in-app recebe push.
// Não há preferência separada, porque o opt-in já é a permissão que o usuário
// concedeu no navegador — sem ela não existe inscrição gravada aqui.
//
// Alcance por plataforma:
//   • Android/Chrome, Edge, Firefox, Safari do Mac → funciona aberto ou instalado
//   • iPhone/iPad → SÓ com o Office adicionado à Tela de Início (regra da Apple)
//
// Falha nunca sobe: notificação é acessório, não pode derrubar a ação que a
// originou (aprovar, publicar, fechar mês...).

import webpush from 'web-push';
import db from '../../models/sequelize/index.js';

const { PushSubscription, PushVapidKey } = db;

let cachedKeys = null;

/**
 * Chaves VAPID. Env manda; sem env, usa a linha gerada no boot pelo
 * lib/ensureVapidKeys.js. Retorna null quando não há chave — aí o push
 * simplesmente não opera e o resto dos canais segue normal.
 */
export async function getVapidKeys() {
    if (cachedKeys !== null) return cachedKeys;

    const subject = process.env.VAPID_SUBJECT || 'mailto:ti@menin.com.br';

    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        cachedKeys = {
            publicKey: process.env.VAPID_PUBLIC_KEY,
            privateKey: process.env.VAPID_PRIVATE_KEY,
            subject,
        };
        return cachedKeys;
    }

    try {
        const row = await PushVapidKey.findOne({ order: [['id', 'ASC']] });
        if (row) {
            cachedKeys = {
                publicKey: row.public_key,
                privateKey: row.private_key,
                subject: row.subject || subject,
            };
            return cachedKeys;
        }
    } catch (err) {
        console.warn('[push] não consegui ler as chaves VAPID:', err?.message || err);
    }

    cachedKeys = null;
    return null;
}

/** Invalida o cache — usado pelo ensureVapidKeys logo após gerar o par. */
export function resetVapidCache() {
    cachedKeys = null;
}

async function configured() {
    const keys = await getVapidKeys();
    if (!keys) return false;
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    return true;
}

/** Grava/atualiza a inscrição de um aparelho. Idempotente por endpoint. */
export async function saveSubscription(userId, { subscription, userAgent, standalone } = {}) {
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
        const err = new Error('inscrição de push incompleta');
        err.status = 400;
        throw err;
    }

    const existing = await PushSubscription.findOne({ where: { endpoint } });
    if (existing) {
        // Endpoint pode migrar de dono (aparelho compartilhado, troca de login).
        await existing.update({
            user_id: userId,
            p256dh,
            auth,
            user_agent: (userAgent || '').slice(0, 400) || null,
            standalone: !!standalone,
            failure_count: 0,
        });
        return existing;
    }

    return PushSubscription.create({
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: (userAgent || '').slice(0, 400) || null,
        standalone: !!standalone,
    });
}

export async function removeSubscription(userId, endpoint) {
    if (!endpoint) return 0;
    return PushSubscription.destroy({ where: { user_id: userId, endpoint } });
}

export async function listForUser(userId) {
    return PushSubscription.findAll({
        where: { user_id: userId },
        attributes: ['id', 'endpoint', 'user_agent', 'standalone', 'last_success_at', 'created_at'],
        order: [['created_at', 'DESC']],
    });
}

/**
 * Envia para todos os aparelhos de um usuário.
 * Retorna { sent, removed }. Nunca lança.
 */
export async function sendToUser(userId, { title, body, link, tag, notificationId, requireInteraction } = {}) {
    let sent = 0;
    let removed = 0;

    try {
        if (!(await configured())) return { sent, removed };

        const subs = await PushSubscription.findAll({ where: { user_id: userId } });
        if (!subs.length) return { sent, removed };

        const payload = JSON.stringify({
            title: title || 'Menin Office',
            // O corpo aparece na tela bloqueada. Corta pra não virar parede de texto.
            body: (body || '').slice(0, 240),
            link: link || '/',
            tag: tag || undefined,
            notificationId: notificationId || null,
            requireInteraction: !!requireInteraction,
            timestamp: Date.now(),
        });

        await Promise.all(subs.map(async (sub) => {
            try {
                await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    payload,
                    { TTL: 60 * 60 * 24 }
                );
                sent++;
                await sub.update({ last_success_at: new Date(), failure_count: 0 });
            } catch (err) {
                const status = err?.statusCode;
                // 404/410 = inscrição morta (app desinstalado, permissão revogada).
                // Limpa na hora, senão a tabela vira cemitério e o envio fica lento.
                if (status === 404 || status === 410) {
                    await sub.destroy().catch(() => { });
                    removed++;
                    return;
                }
                await sub.increment('failure_count').catch(() => { });
                console.warn(`[push] falha para inscrição ${sub.id} (status ${status}):`, err?.message || err);
            }
        }));
    } catch (err) {
        console.warn('[push] sendToUser falhou:', err?.message || err);
    }

    return { sent, removed };
}

export default { getVapidKeys, resetVapidCache, saveSubscription, removeSubscription, listForUser, sendToUser };
