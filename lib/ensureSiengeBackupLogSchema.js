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
