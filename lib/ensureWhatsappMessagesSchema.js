// lib/ensureWhatsappMessagesSchema.js
//
// Colunas de PRICING em whatsapp_messages (painel de Gastos do WhatsApp).
// O webhook da Meta manda billable/pricing_model/type no status; sem estas
// colunas o log e as estatísticas quebram (42703 column does not exist).
//
// Por que um patch explícito e não só o model: o sync({alter}) do boot nem
// sempre adiciona colunas novas de forma confiável, e o gate de fingerprint
// pode pular a fase inteira. ALTER ... ADD COLUMN IF NOT EXISTS é idempotente
// e barato — roda sempre que a fase de schema roda. Mesmo padrão dos demais
// ensure*Schema; nada de script manual.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
  `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS billable BOOLEAN`,
  `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS pricing_model VARCHAR(20)`,
  `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS pricing_type VARCHAR(40)`,
];

export async function ensureWhatsappMessagesSchema() {
  let applied = 0, failed = 0;
  for (const sql of STATEMENTS) {
    try { await db.sequelize.query(sql); applied++; }
    catch (err) {
      failed++;
      console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
      console.warn(`    SQL: ${sql.slice(0, 100)}...`);
    }
  }
  console.log(`✅ [SchemaPatch] WhatsApp Messages (pricing) schema garantido (${applied} OK, ${failed} skip).`);
}
