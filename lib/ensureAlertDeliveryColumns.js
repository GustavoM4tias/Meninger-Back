// lib/ensureAlertDeliveryColumns.js
//
// Colunas da preferência de entrega dos alertas no WhatsApp (14/09/2026):
//   alert_rules.delivery            JSON   { format, ask_first } por regra
//   whatsapp_automations.settings   JSONB  { delivery } padrão global
//
// Roda FORA do gate de schema, antes do AlertEngine.boot: o model AlertRule
// declara `delivery`, então TODA query dele ("column delivery does not exist")
// quebra até o ALTER rodar - e o gate pula a fase inteira quando o fingerprint
// não mudou ou com SKIP_DB_SYNC. Foi o que aconteceu em 15/09/2026 no primeiro
// boot depois do deploy. Idempotente e barato (2 statements).

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS delivery JSON`,
    `ALTER TABLE whatsapp_automations ADD COLUMN IF NOT EXISTS settings JSONB`,
];

export async function ensureAlertDeliveryColumns() {
    let ok = 0, falhas = 0;
    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); ok++; }
        catch (err) {
            // Tabela ainda não existe (banco novo): o sync do model a cria já com a coluna.
            falhas++;
            console.warn(`⚠️  [SchemaPatch][AlertDelivery] ${err.message} — SQL: ${sql.slice(0, 70)}`);
        }
    }
    console.log(`✅ [SchemaPatch][AlertDelivery] colunas de entrega garantidas (${ok} OK, ${falhas} skip).`);
}

export default ensureAlertDeliveryColumns;
