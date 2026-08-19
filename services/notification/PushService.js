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

/** A fase de schema roda em segundo plano e pode ter sido pulada. Se a tabela
 *  ainda não existe, cria e refaz a operação uma vez. sync() sem alter só cria
 *  o que falta, então é seguro chamar em produção. */
function tabelaFaltando(err) {
    return /does not exist|no such table/i.test(String(err?.message || ''));
}

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
        const row = await ensureKeyRow(subject);
        if (row) {
            cachedKeys = {
                publicKey: row.public_key,
                privateKey: row.private_key,
                subject: row.subject || subject,
            };
            return cachedKeys;
        }
    } catch (err) {
        console.error('[push] não consegui obter as chaves VAPID:', err?.message || err);
    }

    cachedKeys = null;
    return null;
}

/**
 * Devolve a linha das chaves, gerando na hora se ainda não existir.
 *
 * A geração TAMBÉM acontece no boot (lib/ensureVapidKeys.js), mas não dá para
 * depender só disso: o gate de schema pula a fase de patches quando nada mudou,
 * a fase roda em segundo plano depois do listen, e um patch anterior que falhe
 * impede os seguintes. Qualquer um desses cenários deixaria o push morto sem
 * ninguém perceber. Aqui a chave nasce na primeira vez que alguém precisa dela.
 *
 * Idempotente: id fixo 1, então uma corrida entre dois requests dá violação de
 * chave e o perdedor relê a linha do vencedor, em vez de criar um segundo par
 * (o que invalidaria as inscrições já feitas com o primeiro).
 */
async function ensureKeyRow(subject) {
    // A LEITURA vem primeiro e é ela que quebra quando a tabela não existe —
    // não o create. Sem este try a exceção escapava daqui e nunca chegava na
    // recuperação lá embaixo, então a auto-criação não acontecia.
    let existing = null;
    try {
        existing = await PushVapidKey.findOne({ order: [['id', 'ASC']] });
    } catch (err) {
        if (!tabelaFaltando(err)) throw err;
        await PushVapidKey.sync();
        console.log('🔔 [VAPID] tabela push_vapid_keys criada sob demanda.');
    }
    if (existing) return existing;

    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    const payload = { id: 1, public_key: publicKey, private_key: privateKey, subject };

    try {
        const row = await PushVapidKey.create(payload);
        console.log('🔔 [VAPID] par de chaves gerado sob demanda e gravado.');
        return row;
    } catch (err) {
        // Tabela ainda não existe (fase de schema pulada ou em andamento):
        // cria e tenta de novo. sync() sem alter só cria o que falta.
        if (tabelaFaltando(err)) {
            await PushVapidKey.sync();
            const row = await PushVapidKey.create(payload);
            console.log('🔔 [VAPID] tabela criada e par de chaves gravado sob demanda.');
            return row;
        }

        // Corrida com outro request: relê a linha que o vencedor criou.
        const again = await PushVapidKey.findOne({ order: [['id', 'ASC']] });
        if (again) return again;
        throw err;
    }
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

    let existing;
    try {
        existing = await PushSubscription.findOne({ where: { endpoint } });
    } catch (err) {
        if (!tabelaFaltando(err)) throw err;
        await PushSubscription.sync();
        console.log('🔔 [push] tabela push_subscriptions criada sob demanda.');
        existing = null;
    }

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
