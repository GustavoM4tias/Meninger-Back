// lib/ensureMarketingCaptureSchema.js
//
// Cria os índices das tabelas de captação de marketing (inbound_leads,
// inbound_lead_events). Os índices ficam aqui — e não no array `indexes` do
// model — porque sync({ alter: true }) tem bug ao criar índice novo em tabela
// existente (ver feedback de schema via sequelize.sync alter).
// CREATE INDEX IF NOT EXISTS é idempotente — pode rodar todo boot.
//
// Roda no boot, DEPOIS do sync — quando as tabelas já existem.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // Fase 3 — colunas opcionais para LPs públicas. ADD COLUMN IF NOT EXISTS é idempotente.
    `ALTER TABLE lead_forms ADD COLUMN IF NOT EXISTS fields_config JSONB`,
    `ALTER TABLE lead_forms ADD COLUMN IF NOT EXISTS page_config JSONB`,

    `CREATE INDEX IF NOT EXISTS inbound_leads_status        ON inbound_leads (status)`,
    `CREATE INDEX IF NOT EXISTS inbound_leads_channel       ON inbound_leads (channel)`,
    `CREATE INDEX IF NOT EXISTS inbound_leads_email         ON inbound_leads (email)`,
    `CREATE INDEX IF NOT EXISTS inbound_leads_telefone      ON inbound_leads (telefone)`,
    `CREATE INDEX IF NOT EXISTS inbound_leads_cv_idlead     ON inbound_leads (cv_idlead)`,
    `CREATE INDEX IF NOT EXISTS inbound_leads_next_retry_at ON inbound_leads (next_retry_at)`,
    `CREATE INDEX IF NOT EXISTS inbound_leads_created_at    ON inbound_leads (created_at)`,
    `CREATE INDEX IF NOT EXISTS inbound_leads_source_form   ON inbound_leads (source_form_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS inbound_leads_meta_leadgen ON inbound_leads (meta_leadgen_id) WHERE meta_leadgen_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS inbound_lead_events_lead_id ON inbound_lead_events (inbound_lead_id)`,
    `CREATE INDEX IF NOT EXISTS inbound_lead_events_created ON inbound_lead_events (created_at)`,
];

export async function ensureMarketingCaptureSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch] Marketing capture — falha: ${err.message}`);
        }
    }
    console.log(`✅ [SchemaPatch] Marketing capture schema garantido (${applied} OK, ${failed} skip).`);
}
