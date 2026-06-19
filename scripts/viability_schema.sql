-- viability_schema.sql
-- Schema da Viabilidade de Marketing — idempotente, pode rodar quantas vezes precisar.
-- Espelha o que lib/ensureViabilitySchema.js aplica no boot. Use para rodar manualmente
-- em produção/staging se o sync({ alter: true }) não tiver criado as colunas.

-- Fase 1 — Custo Loja (R$) por centro de custo na projeção.
-- Default 0; preenchido só no CC que tem loja. Entra no pool de orçamento de marketing.
ALTER TABLE sales_projection_enterprises
    ADD COLUMN IF NOT EXISTS custo_loja NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Fase 2 — config admin de quais departamentos contam como marketing (global).
CREATE TABLE IF NOT EXISTS viability_marketing_departments (
    department_name VARCHAR(120) PRIMARY KEY,
    is_marketing    BOOLEAN NOT NULL DEFAULT true,
    updated_by      VARCHAR(120),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Fase 2/3 — configuração por EMPRESA Sienge (company_id): bloqueadas consideradas
-- disponíveis (default 0) + exceções de departamento de marketing
-- (JSONB { "<department_name>": true|false }).
-- Migração idempotente: se a tabela existir com a PK antiga (enterprise_key), recria limpa.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'viability_enterprise_settings' AND column_name = 'enterprise_key')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'viability_enterprise_settings' AND column_name = 'company_id')
  THEN
    DROP TABLE viability_enterprise_settings;
  END IF;
END
$do$;

CREATE TABLE IF NOT EXISTS viability_enterprise_settings (
    company_id                   INTEGER PRIMARY KEY,
    blocked_considered_available INTEGER NOT NULL DEFAULT 0,
    marketing_dept_overrides     JSONB,
    status_override              VARCHAR(20),
    updated_by                   VARCHAR(120),
    created_at                   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMP NOT NULL DEFAULT NOW()
);
-- categoria manual do empreendimento (null = automático)
ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS status_override VARCHAR(20);
