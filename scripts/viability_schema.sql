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

-- Fase 2 — configuração por empreendimento: bloqueadas consideradas disponíveis (default 0)
-- + exceções de departamento de marketing (JSONB { "<department_name>": true|false }).
CREATE TABLE IF NOT EXISTS viability_enterprise_settings (
    enterprise_key               VARCHAR(80) PRIMARY KEY,
    blocked_considered_available INTEGER NOT NULL DEFAULT 0,
    marketing_dept_overrides     JSONB,
    updated_by                   VARCHAR(120),
    created_at                   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMP NOT NULL DEFAULT NOW()
);
