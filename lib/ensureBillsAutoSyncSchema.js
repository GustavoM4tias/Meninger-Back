// lib/ensureBillsAutoSyncSchema.js
//
// Patch defensivo: garante que todas as colunas/tabelas usadas pelo bills auto-sync
// existem no banco, mesmo quando sync({ alter: true }) falha silenciosamente
// (problemas conhecidos com ENUMs e ordem de criação de índices).
//
// Idempotente — usa IF NOT EXISTS em tudo, pode rodar todo boot.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // favorites — corrige created_at sem default + amplia router/section para 120
    `ALTER TABLE favorites ALTER COLUMN created_at SET DEFAULT NOW()`,
    `ALTER TABLE favorites ALTER COLUMN router TYPE VARCHAR(120)`,
    `ALTER TABLE favorites ALTER COLUMN section TYPE VARCHAR(120)`,

    // sienge_bills — re-sync ciente de status
    `ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS is_settled BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS current_status VARCHAR(20) NOT NULL DEFAULT 'open'`,
    `ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS installments_synced_at TIMESTAMP`,
    `ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS last_full_sync_at TIMESTAMP`,

    // expenses — status propagado da parcela
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'open'`,
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_at DATE`,

    // bills_sync_logs (criada via model — patch só pra caso falhe)
    `CREATE TABLE IF NOT EXISTS bills_sync_logs (
        id                   SERIAL PRIMARY KEY,
        enterprise_city_id   BIGINT,
        cost_center_id       INTEGER NOT NULL,
        mode                 VARCHAR(20) NOT NULL DEFAULT 'default',
        started_at           TIMESTAMP NOT NULL,
        finished_at          TIMESTAMP,
        status               VARCHAR(20) NOT NULL DEFAULT 'running',
        total_bills          INTEGER,
        new_bills            INTEGER,
        updated_bills        INTEGER,
        installments_synced  INTEGER,
        expenses_updated     INTEGER,
        duration_ms          INTEGER,
        error_message        TEXT,
        triggered_by         VARCHAR(20) NOT NULL DEFAULT 'cron',
        created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
    )`,

    // bills_auto_sync_subscriptions (criada via model — patch só pra caso falhe)
    `CREATE TABLE IF NOT EXISTS bills_auto_sync_subscriptions (
        enterprise_city_id BIGINT PRIMARY KEY,
        enabled_by         VARCHAR(120),
        enabled_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )`,

    // cost_center_overrides — admin sobrepõe o nome exibido do empreendimento
    `CREATE TABLE IF NOT EXISTS cost_center_overrides (
        cost_center_id INTEGER PRIMARY KEY,
        display_name   VARCHAR(200) NOT NULL,
        updated_by     VARCHAR(120),
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )`,

    // expense_department_visibility — admin escolhe quais departamentos aparecem no filtro
    `CREATE TABLE IF NOT EXISTS expense_department_visibility (
        name        VARCHAR(120) PRIMARY KEY,
        hidden      BOOLEAN NOT NULL DEFAULT false,
        updated_by  VARCHAR(120),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )`,

    // Índices úteis (idempotentes)
    `CREATE INDEX IF NOT EXISTS sienge_bills_is_settled ON sienge_bills (is_settled)`,
    `CREATE INDEX IF NOT EXISTS sienge_bills_current_status ON sienge_bills (current_status)`,
    `CREATE INDEX IF NOT EXISTS sienge_bills_installments_synced_at ON sienge_bills (installments_synced_at)`,
    `CREATE INDEX IF NOT EXISTS expenses_status ON expenses (status)`,
    `CREATE INDEX IF NOT EXISTS bills_sync_logs_cost_center_id ON bills_sync_logs (cost_center_id)`,
    `CREATE INDEX IF NOT EXISTS bills_sync_logs_enterprise_city_id ON bills_sync_logs (enterprise_city_id)`,
    `CREATE INDEX IF NOT EXISTS bills_sync_logs_started_at ON bills_sync_logs (started_at)`,
];

export async function ensureBillsAutoSyncSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
            console.warn(`    SQL: ${sql.slice(0, 100)}...`);
        }
    }
    console.log(`✅ [SchemaPatch] Bills auto-sync schema garantido (${applied} OK, ${failed} skip).`);
}
