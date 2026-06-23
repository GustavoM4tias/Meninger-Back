// lib/ensureAlertSharesSchema.js
//
// Rede de segurança da tabela alert_shares (compartilhamento de alertas). A
// tabela normalmente nasce do model no sync({alter:false}) do boot; este patch é
// o "caso falhe" (ECONNRESET em CREATE remoto, etc.) e garante os ÍNDICES — que
// ficam fora do model de propósito (sync({alter:true}) tem bug de criar índice
// antes da coluna). Idempotente — IF NOT EXISTS. Mesmo padrão dos demais ensure*.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS alert_shares (
      id               SERIAL PRIMARY KEY,
      alert_rule_id    INTEGER     NOT NULL,
      from_user_id     INTEGER     NOT NULL,
      to_user_id       INTEGER     NOT NULL,
      status           VARCHAR(20) NOT NULL DEFAULT 'pending',
      note             TEXT,
      channels         JSON        NOT NULL DEFAULT '{"inapp":true,"email":true,"whatsapp":false}',
      meta_message_id  VARCHAR(120),
      cloned_rule_id   INTEGER,
      expires_at       TIMESTAMP   NOT NULL DEFAULT NOW(),
      responded_at     TIMESTAMP,
      created_at       TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS alert_shares_to_status_idx ON alert_shares (to_user_id, status)`,
  `CREATE INDEX IF NOT EXISTS alert_shares_wamid_idx     ON alert_shares (meta_message_id)`,
  `CREATE INDEX IF NOT EXISTS alert_shares_rule_idx      ON alert_shares (alert_rule_id)`,
];

export async function ensureAlertSharesSchema() {
  let applied = 0, failed = 0;
  for (const sql of STATEMENTS) {
    try { await db.sequelize.query(sql); applied++; }
    catch (err) {
      failed++;
      console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
      console.warn(`    SQL: ${sql.slice(0, 100)}...`);
    }
  }
  console.log(`✅ [SchemaPatch] Alert Shares schema garantido (${applied} OK, ${failed} skip).`);
}
