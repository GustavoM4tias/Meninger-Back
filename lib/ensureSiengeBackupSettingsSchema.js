// lib/ensureSiengeBackupSettingsSchema.js
//
// Patch defensivo da regra de operação da carga do Sienge. O boot roda
// `sync({ alter: false })` quando o schema não mudou: cria tabela nova, mas não
// acrescenta coluna em tabela existente. Tudo aqui é idempotente.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS sienge_backup_settings (
        id                      SERIAL PRIMARY KEY,
        active                  BOOLEAN     NOT NULL DEFAULT TRUE,
        cron_expression         VARCHAR(64) DEFAULT '0 5 * * *',
        retry_max_attempts      INTEGER     NOT NULL DEFAULT 5,
        retry_backoff_minutes   JSONB       NOT NULL DEFAULT '[15,30,60,120]'::jsonb,
        retry_until_hour        INTEGER     NOT NULL DEFAULT 20,
        restore_retry_attempts  INTEGER     NOT NULL DEFAULT 2,
        watchdog_enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
        watchdog_cron           VARCHAR(64) DEFAULT '*/30 * * * *',
        stale_limit_hours       INTEGER     NOT NULL DEFAULT 28,
        restore_jobs            INTEGER     NOT NULL DEFAULT 2,
        restore_timeout_minutes INTEGER     NOT NULL DEFAULT 90,
        notify_user_ids         JSONB       NOT NULL DEFAULT '[]'::jsonb,
        alert_on_failure        BOOLEAN     NOT NULL DEFAULT TRUE,
        alert_on_stale          BOOLEAN     NOT NULL DEFAULT TRUE,
        alert_open              BOOLEAN     NOT NULL DEFAULT FALSE,
        last_alert_at           TIMESTAMPTZ,
        last_alert_key          VARCHAR(120),
        updated_by              INTEGER,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Colunas acrescentadas depois da primeira versão da tabela.
    `ALTER TABLE sienge_backup_settings ADD COLUMN IF NOT EXISTS restore_retry_attempts INTEGER NOT NULL DEFAULT 2`,
    `ALTER TABLE sienge_backup_settings ADD COLUMN IF NOT EXISTS alert_open BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE sienge_backup_settings ADD COLUMN IF NOT EXISTS last_alert_key VARCHAR(120)`,
];

export async function ensureSiengeBackupSettingsSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][SiengeBackupSettings] ${err.message}`);
        }
    }

    // Semeia a linha única. O cron entra com o valor que já está valendo em
    // produção (env var), para o primeiro boot não mudar o horário da carga.
    try {
        await db.sequelize.query(
            `INSERT INTO sienge_backup_settings (id, cron_expression)
             VALUES (1, :cron)
             ON CONFLICT (id) DO NOTHING`,
            { replacements: { cron: process.env.SIENGE_BACKUP_CRON || '0 5 * * *' } }
        );
        applied++;
    } catch (err) {
        failed++;
        console.warn(`⚠️  [SchemaPatch][SiengeBackupSettings] seed: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch] Sienge backup settings garantido (${applied} OK, ${failed} skip).`);
}

export default ensureSiengeBackupSettingsSchema;
