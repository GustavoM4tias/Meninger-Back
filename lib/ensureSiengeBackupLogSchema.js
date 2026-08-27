// lib/ensureSiengeBackupLogSchema.js
//
// Patch defensivo: garante que as colunas novas de telemetria do backup
// Sienge existem, mesmo quando sync({ alter: true }) é desabilitado.
//
// Idempotente — pode rodar todo boot.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS stage_timings     JSONB    DEFAULT '{}'::jsonb`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS bytes_downloaded  BIGINT`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS download_attempts INTEGER`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS restore_log_tail  TEXT`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS toc_totals        JSONB    DEFAULT '{}'::jsonb`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS phase_progress    JSONB    DEFAULT '{}'::jsonb`,

    // Telemetria acrescentada no conserto da carga diária (ver
    // services/sienge/SiengeBackupService.js). `instance_id` é o que permite
    // saber DE QUAL container veio cada tentativa — sem isso foi preciso
    // deduzir pelos stage_timings que duas instâncias competiam pelo staging.
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS attempt            INTEGER`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS instance_id        VARCHAR(120)`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS pg_restore_bin     TEXT`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS heartbeat_at       TIMESTAMPTZ`,
    `ALTER TABLE sienge_backup_logs ADD COLUMN IF NOT EXISTS mirror_last_change TIMESTAMPTZ`,

    // A tela e o vigia consultam sempre "a última rodada" e "a última com
    // sucesso"; sem índice isso é seq scan numa tabela que só cresce.
    `CREATE INDEX IF NOT EXISTS sienge_backup_logs_started_at_idx ON sienge_backup_logs (started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS sienge_backup_logs_status_started_idx ON sienge_backup_logs (status, started_at DESC)`,
];

export async function ensureSiengeBackupLogSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][SiengeBackupLog] ${err.message}`);
        }
    }
    console.log(`✅ [SchemaPatch] Sienge backup log schema garantido (${applied} OK, ${failed} skip).`);
}
