// lib/ensureEnvioSiengeWatchSchema.js
//
// Patch defensivo do vigia do envio ao ERP. O boot roda
// `sync({ alter: false })`: cria tabela nova, mas não acrescenta coluna em
// tabela que já existe. Tudo aqui é idempotente e pode rodar a cada boot.
//
// Os defaults dos limiares NÃO são chute: saíram da distribuição real de 1274
// envios de 2026 (p50 20h, p75 ~5 dias, p90 ~25 dias) - ver o cabeçalho de
// services/sienge/envioSiengeWatchService.js.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS envio_sienge_watch_settings (
        id                  SERIAL PRIMARY KEY,
        active              BOOLEAN     NOT NULL DEFAULT FALSE,
        idsituacao_vigiada  INTEGER     DEFAULT 17,
        dias_atraso         INTEGER     DEFAULT 5,
        dias_critico        INTEGER     DEFAULT 15,
        ato_pago_e_critico  BOOLEAN     NOT NULL DEFAULT TRUE,
        confirmar_no_sienge BOOLEAN     NOT NULL DEFAULT TRUE,
        notify_user_ids     JSONB       NOT NULL DEFAULT '[]'::jsonb,
        cron_expression     VARCHAR(64) DEFAULT '30 9 * * *',
        last_run_at         TIMESTAMPTZ,
        last_run_resumo     JSONB,
        updated_by          INTEGER,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `INSERT INTO envio_sienge_watch_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,

    `CREATE TABLE IF NOT EXISTS envio_sienge_watch_items (
        id                      SERIAL PRIMARY KEY,
        idreserva               INTEGER     NOT NULL UNIQUE,
        empreendimento          VARCHAR(255),
        unidade                 VARCHAR(255),
        titular_nome            VARCHAR(255),
        pendente_desde          TIMESTAMPTZ NOT NULL,
        data_cad_erp            TIMESTAMPTZ,
        ultima_verificacao      TIMESTAMPTZ,
        severidade              VARCHAR(20) NOT NULL DEFAULT 'na_fila',
        ato_pago                BOOLEAN     NOT NULL DEFAULT FALSE,
        confirmado_sem_contrato BOOLEAN,
        resolvido_em            TIMESTAMPTZ,
        espera_horas            INTEGER,
        contrato_erp            VARCHAR(64),
        avisado_em              TIMESTAMPTZ,
        avisado_severidade      VARCHAR(20),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE envio_sienge_watch_items ADD COLUMN IF NOT EXISTS data_cad_erp TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_envio_sienge_watch_abertos
        ON envio_sienge_watch_items (severidade) WHERE resolvido_em IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_envio_sienge_watch_resolvido
        ON envio_sienge_watch_items (resolvido_em)`,
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
