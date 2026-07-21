// lib/ensureEventsSchema.js
//
// Patch idempotente da tabela events (roda a cada deploy, sem efeito colateral):
//   1. Garante a coluna reminded_at (controle do lembrete D-1 do
//      eventReminderScheduler — antes era a tag interna '__reminded__' em
//      `tags`, que vazava para a tela e para as respostas da Eme).
//   2. Migra o legado: quem tem a tag ganha reminded_at (não re-lembra) e a
//      tag é REMOVIDA de `tags` — limpa a UI de uma vez.

import db from '../models/sequelize/index.js';

export async function ensureEventsSchema() {
    try {
        await db.sequelize.query(`
            ALTER TABLE events ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ NULL
        `);
        const [, meta] = await db.sequelize.query(`
            UPDATE events
            SET reminded_at = COALESCE(reminded_at, NOW()),
                tags = (tags::jsonb - '__reminded__')::json
            WHERE tags::jsonb ? '__reminded__'
        `);
        const n = meta?.rowCount ?? 0;
        if (n) console.log(`✅ events: tag interna '__reminded__' migrada p/ reminded_at em ${n} evento(s).`);
    } catch (e) {
        console.warn('⚠️  ensureEventsSchema falhou:', e.message);
    }
}
