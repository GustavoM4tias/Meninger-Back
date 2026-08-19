// lib/ensureVapidKeys.js
//
// Gera o par de chaves VAPID no primeiro boot e grava na tabela push_vapid_keys.
// Idempotente: com chave já gravada (ou definida em env) não faz nada.
//
// Existe pra que ligar o push não dependa de ninguém rodar comando nem colar
// variável de ambiente na mão — mesmo princípio dos outros ensure*.
//
// ⚠️ Nunca regera. Trocar a chave derruba todas as inscrições ativas e cada
// aparelho precisaria autorizar de novo.

import webpush from 'web-push';
import db from '../models/sequelize/index.js';
import { resetVapidCache } from '../services/notification/PushService.js';

export async function ensureVapidKeys() {
    const { PushVapidKey } = db;

    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        console.log('🔔 [VAPID] usando as chaves do ambiente.');
        return;
    }

    const existing = await PushVapidKey.findOne({ order: [['id', 'ASC']] });
    if (existing) return;

    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    await PushVapidKey.create({
        public_key: publicKey,
        private_key: privateKey,
        subject: process.env.VAPID_SUBJECT || 'mailto:ti@menin.com.br',
    });
    resetVapidCache();

    console.log('🔔 [VAPID] par de chaves gerado e gravado em push_vapid_keys.');
}

export default ensureVapidKeys;
