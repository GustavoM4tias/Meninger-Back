// lib/ensureSiengeConnectionSchema.js
//
// Patch defensivo da CONEXÃO com o Sienge (endereços, usuários e senhas). Mesmo
// contrato dos outros ensure*: idempotente, roda todo boot, nunca script manual.
//
// A linha nasce VAZIA de propósito. Campo vazio significa "use a env var", que é
// o que já está valendo em produção - assim o primeiro boot depois deste patch
// não muda nenhuma conexão. A tela é que passa a poder sobrescrever.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS sienge_connection_settings (
        id                        SERIAL PRIMARY KEY,
        backup_url                TEXT,
        backup_md5_url            TEXT,
        backup_user               VARCHAR(180),
        backup_password_enc       TEXT,
        pg_url_enc                TEXT,
        pg_database               VARCHAR(63),
        pg_staging_database       VARCHAR(63),
        pg_read_url_enc           TEXT,
        api_base_url              TEXT,
        api_user                  VARCHAR(180),
        api_password_enc          TEXT,
        auto_restore_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
        download_max_attempts     INTEGER     NOT NULL DEFAULT 3,
        timezone                  VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
        read_pool_max             INTEGER     NOT NULL DEFAULT 4,
        read_statement_timeout_ms INTEGER     NOT NULL DEFAULT 60000,
        last_test_at              TIMESTAMPTZ,
        last_test_ok              BOOLEAN,
        last_test_detail          JSONB,
        updated_by                INTEGER,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Colunas acrescentadas depois da primeira versão da tabela entram aqui,
    // uma linha cada (ADD COLUMN IF NOT EXISTS).
];

export async function ensureSiengeConnectionSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][SiengeConnection] ${err.message}`);
        }
    }

    // Semeia a linha única com os valores de OPERAÇÃO que já estão valendo no
    // ambiente. Endereço e senha ficam nulos de propósito (nulo = "use a env
    // var"), mas booleano e número são NOT NULL: sem semear com o env, criar a
    // linha ligaria o restore automático de quem o tinha desligado no painel.
    try {
        await db.sequelize.query(
            `INSERT INTO sienge_connection_settings
                 (id, auto_restore_enabled, download_max_attempts, timezone,
                  read_pool_max, read_statement_timeout_ms)
             VALUES (1, :autoRestore, :downloadAttempts, :tz, :poolMax, :stmtTimeout)
             ON CONFLICT (id) DO NOTHING`,
            {
                replacements: {
                    autoRestore: process.env.ENABLE_SIENGE_AUTO_RESTORE !== 'false',
                    downloadAttempts: Number(process.env.SIENGE_DOWNLOAD_MAX_ATTEMPTS) || 3,
                    tz: process.env.SIENGE_BACKUP_TZ || 'America/Sao_Paulo',
                    poolMax: Number(process.env.SIENGE_READ_POOL_MAX) || 4,
                    stmtTimeout: Number(process.env.SIENGE_READ_STATEMENT_TIMEOUT_MS) || 60_000,
                },
            }
        );
        applied++;
    } catch (err) {
        failed++;
        console.warn(`⚠️  [SchemaPatch][SiengeConnection] seed: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch] Sienge connection garantido (${applied} OK, ${failed} skip).`);
}

export default ensureSiengeConnectionSchema;
