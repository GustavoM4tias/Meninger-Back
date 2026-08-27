// lib/ensureEnvioSiengeWatchSchema.js
//
// Patch defensivo do vigia do envio ao ERP. O boot roda
// `sync({ alter: false })`: cria tabela nova, mas não acrescenta coluna em
// tabela existente. Tudo aqui é idempotente.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS envio_sienge_watch_settings (
        id                  SERIAL PRIMARY KEY,
        active              BOOLEAN     NOT NULL DEFAULT FALSE,
        minutos_limite      INTEGER     DEFAULT 30,
        idsituacao_vigiada  INTEGER     DEFAULT 17,
        notify_user_ids     JSONB       NOT NULL DEFAULT '[]'::jsonb,
        cron_expression     VARCHAR(64) DEFAULT '*/15 * * * *',
        avisados_ids        JSONB       NOT NULL DEFAULT '[]'::jsonb,
        last_run_at         TIMESTAMPTZ,
        last_run_resumo     JSONB,
        updated_by          INTEGER,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE envio_sienge_watch_settings ADD COLUMN IF NOT EXISTS minutos_limite INTEGER DEFAULT 30`,
    `ALTER TABLE envio_sienge_watch_settings ADD COLUMN IF NOT EXISTS avisados_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `INSERT INTO envio_sienge_watch_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,

    // A primeira versão do vigia acompanhava cada reserva numa tabela própria,
    // com relógio e severidade. A régua certa é mais simples - passou de ~6
    // rodadas do lote, é erro - e essa tabela virou lixo antes de entrar em uso.
    // Só continha espelho de reservas, nada que não se recalcule.
    `DROP TABLE IF EXISTS envio_sienge_watch_items`,
];

export default async function ensureEnvioSiengeWatchSchema() {
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
        } catch (err) {
            console.warn('[ensureEnvioSiengeWatchSchema] falhou:', err.message);
        }
    }
}
