// lib/ensureViabilitySchema.js
//
// Patch defensivo da Viabilidade de Marketing. Garante colunas/tabelas novas
// mesmo quando sync({ alter: true }) falha silenciosamente (ENUMs, ordem de
// índices, conexões remotas que caem no meio do ALTER).
//
// Idempotente — usa IF NOT EXISTS em tudo, pode rodar todo boot.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // Fase 1 — Custo Loja (R$) por centro de custo na projeção. Entra no pool de
    // orçamento de marketing da Viabilidade. Default 0; preenchido só no CC que
    // tem loja. Empreendimentos sem loja ficam em 0 e não afetam o cálculo.
    `ALTER TABLE sales_projection_enterprises ADD COLUMN IF NOT EXISTS custo_loja NUMERIC(14,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE sales_projection_enterprises ADD COLUMN IF NOT EXISTS blocked_considered_available INTEGER NOT NULL DEFAULT 0`,

    // Fase 2 — config admin: departamentos de marketing (global) + settings por empreendimento.
    `CREATE TABLE IF NOT EXISTS viability_marketing_departments (
        department_name VARCHAR(120) PRIMARY KEY,
        is_marketing    BOOLEAN NOT NULL DEFAULT true,
        updated_by      VARCHAR(120),
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    // Migração: a tabela pode ter sido criada antes com PK enterprise_key (Fase 2).
    // Como o keying antigo era inválido (sem dados úteis), recria limpa com company_id.
    // Idempotente: só dropa se tiver a coluna antiga e NÃO tiver a nova.
    `DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'viability_enterprise_settings' AND column_name = 'enterprise_key')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'viability_enterprise_settings' AND column_name = 'company_id')
      THEN
        DROP TABLE viability_enterprise_settings;
      END IF;
    END
    $do$`,
    `CREATE TABLE IF NOT EXISTS viability_enterprise_settings (
        company_id                   INTEGER PRIMARY KEY,
        blocked_considered_available INTEGER NOT NULL DEFAULT 0,
        marketing_dept_overrides     JSONB,
        status_override              VARCHAR(20),
        updated_by                   VARCHAR(120),
        created_at                   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    // status_override: categoria manual do empreendimento (null = automático)
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS status_override VARCHAR(20)`,
];

export async function ensureViabilitySchema() {
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
    console.log(`✅ [SchemaPatch] Viabilidade schema garantido (${applied} OK, ${failed} skip).`);
}
