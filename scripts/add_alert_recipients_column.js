// scripts/add_alert_recipients_column.js
//
// Adiciona a coluna de destinatários dos alertas da captação e faz o seed
// inicial (Gustavo Diniz + Taketa) de forma IDEMPOTENTE, via SQL direto —
// necessário enquanto SKIP_DB_SYNC=true estiver ativo no Railway (a fase de
// schema do boot, incluindo ensureMarketingCaptureSchema, é pulada). Rodar:
//   node scripts/add_alert_recipients_column.js
//
// Seguro re-rodar (IF NOT EXISTS + seed só quando a coluna ainda está NULL).
// Mesmo padrão do add_lead_breakdown_columns.js.

import db from '../models/sequelize/index.js';

try {
    await db.sequelize.query(
        `ALTER TABLE marketing_configs ADD COLUMN IF NOT EXISTS alert_recipient_user_ids JSONB`);

    await db.sequelize.query(`
        UPDATE marketing_configs SET alert_recipient_user_ids = sub.ids
          FROM (SELECT jsonb_agg(id) AS ids FROM users
                 WHERE status = true
                   AND (email ILIKE 'gustavo.diniz@menin.com.br' OR username ILIKE '%taketa%')) sub
         WHERE marketing_configs.id = 1
           AND marketing_configs.alert_recipient_user_ids IS NULL
           AND sub.ids IS NOT NULL`);

    const [rows] = await db.sequelize.query(`
        SELECT c.alert_recipient_user_ids,
               (SELECT json_agg(u.username) FROM users u
                 WHERE u.id IN (SELECT jsonb_array_elements_text(c.alert_recipient_user_ids)::int)) AS nomes
          FROM marketing_configs c WHERE c.id = 1`);
    console.log('✅ Coluna garantida. Destinatários atuais:', rows[0] || '(sem linha id=1 — configura pela tela)');
    await db.sequelize.close();
    process.exit(0);
} catch (e) {
    console.error('❌ falha:', e.message);
    process.exit(1);
}
