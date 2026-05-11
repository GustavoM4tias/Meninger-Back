-- ============================================================================
-- Bills Auto-Sync — schema patch idempotente
-- ============================================================================
-- Rode este script quando o `sequelize.sync({ alter: true })` falhar em
-- adicionar as colunas (problema conhecido: tabelas com ENUM como
-- enterprise_cities.source ficam imutáveis pelo alter).
--
-- Tudo é IF NOT EXISTS — pode rodar quantas vezes precisar.
-- ============================================================================

BEGIN;

-- ── sienge_bills: re-sync ciente de status ────────────────────────────────────
ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS is_settled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS current_status VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS installments_synced_at TIMESTAMP;
ALTER TABLE sienge_bills ADD COLUMN IF NOT EXISTS last_full_sync_at TIMESTAMP;

-- ── expenses: status propagado da parcela ─────────────────────────────────────
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_at DATE;

-- NOTA: enterprise_cities NÃO recebe colunas novas — o status do auto-sync é
-- derivado dinamicamente de bills_sync_logs via LATERAL JOIN no controller.
-- (enterprise_cities tem coluna ENUM `source` que bloqueia alter().)

-- ── bills_sync_logs: tabela de histórico ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills_sync_logs (
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
);

-- ── Índices (performance — opcional, mas recomendado) ─────────────────────────
CREATE INDEX IF NOT EXISTS sienge_bills_is_settled              ON sienge_bills (is_settled);
CREATE INDEX IF NOT EXISTS sienge_bills_current_status          ON sienge_bills (current_status);
CREATE INDEX IF NOT EXISTS sienge_bills_installments_synced_at  ON sienge_bills (installments_synced_at);

CREATE INDEX IF NOT EXISTS expenses_status                      ON expenses (status);

CREATE INDEX IF NOT EXISTS bills_sync_logs_cost_center_id       ON bills_sync_logs (cost_center_id);
CREATE INDEX IF NOT EXISTS bills_sync_logs_enterprise_city_id   ON bills_sync_logs (enterprise_city_id);
CREATE INDEX IF NOT EXISTS bills_sync_logs_started_at           ON bills_sync_logs (started_at);
CREATE INDEX IF NOT EXISTS bills_sync_logs_status               ON bills_sync_logs (status);

COMMIT;

-- ── Verificação rápida ────────────────────────────────────────────────────────
-- Rode após o patch para confirmar:
--
--   \d sienge_bills      -- deve listar is_settled, current_status, installments_synced_at, last_full_sync_at
--   \d expenses          -- deve listar status, paid_at
--   \d bills_sync_logs   -- tabela completa
