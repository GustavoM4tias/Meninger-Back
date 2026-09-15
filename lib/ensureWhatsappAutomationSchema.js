// lib/ensureWhatsappAutomationSchema.js
//
// Rede de segurança das tabelas de automação WhatsApp (no-code studio). As
// tabelas normalmente nascem dos models no sync do boot; este patch é o "caso
// falhe" (ECONNRESET em CREATE remoto, etc.). Idempotente — IF NOT EXISTS.
// Mesmo padrão de ensureBillsAutoSyncSchema / ensureEmeBrainSchema.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS whatsapp_automations (
      id                 UUID PRIMARY KEY,
      key                VARCHAR(120) NOT NULL UNIQUE,
      name               VARCHAR(200) NOT NULL,
      description        TEXT,
      enabled            BOOLEAN     NOT NULL DEFAULT true,
      trigger_type       VARCHAR(20) NOT NULL DEFAULT 'event',
      trigger_config     JSONB,
      template_name      VARCHAR(120),
      template_language  VARCHAR(20) NOT NULL DEFAULT 'pt_BR',
      variable_mapping   JSONB,
      buttons            JSONB,
      reply_actions      JSONB,
      recipients         JSONB,
      category           VARCHAR(20) NOT NULL DEFAULT 'UTILITY',
      is_system          BOOLEAN     NOT NULL DEFAULT false,
      created_by         VARCHAR(120),
      updated_by         VARCHAR(120),
      created_at         TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS whatsapp_automation_runs (
      id               UUID PRIMARY KEY,
      automation_id    UUID,
      automation_key   VARCHAR(120),
      trigger_payload  JSONB,
      template_name    VARCHAR(120),
      status           VARCHAR(20) NOT NULL DEFAULT 'sent',
      wamid            VARCHAR(120),
      error            TEXT,
      cost_category    VARCHAR(30),
      created_at       TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS whatsapp_automations_enabled_idx ON whatsapp_automations (enabled)`,
  `CREATE INDEX IF NOT EXISTS whatsapp_automations_trigger_idx ON whatsapp_automations (trigger_type)`,
  `CREATE INDEX IF NOT EXISTS whatsapp_automation_runs_aut_idx ON whatsapp_automation_runs (automation_id)`,
  `CREATE INDEX IF NOT EXISTS whatsapp_automation_runs_created_idx ON whatsapp_automation_runs (created_at)`,
];

export async function ensureWhatsappAutomationSchema() {
  let applied = 0, failed = 0;
  for (const sql of STATEMENTS) {
    try { await db.sequelize.query(sql); applied++; }
    catch (err) {
      failed++;
      console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
      console.warn(`    SQL: ${sql.slice(0, 100)}...`);
    }
  }
  console.log(`✅ [SchemaPatch] WhatsApp Automations schema garantido (${applied} OK, ${failed} skip).`);
}
