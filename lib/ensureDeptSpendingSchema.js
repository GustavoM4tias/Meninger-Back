// lib/ensureDeptSpendingSchema.js
//
// Patch defensivo da tela "Gastos por Departamento" (reestruturação da Viabilidade).
// Garante colunas/tabelas mesmo quando sync({ alter: true }) falha silenciosamente.
//
// Idempotente — usa IF NOT EXISTS em tudo, pode rodar todo boot. Os nomes de tabela
// (`viability_*`) e as colunas da projeção são MANTIDOS para preservar a config já
// cadastrada.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // Colunas na projeção (compartilhadas com a tela de Projeção; mantidas).
    `ALTER TABLE sales_projection_enterprises ADD COLUMN IF NOT EXISTS custo_loja NUMERIC(14,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE sales_projection_enterprises ADD COLUMN IF NOT EXISTS blocked_considered_available INTEGER NOT NULL DEFAULT 0`,

    // Config admin: departamentos acompanhados (global).
    `CREATE TABLE IF NOT EXISTS viability_marketing_departments (
        department_name VARCHAR(120) PRIMARY KEY,
        is_marketing    BOOLEAN NOT NULL DEFAULT true,
        updated_by      VARCHAR(120),
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )`,

    // Config + governança por empreendimento (company_id).
    `CREATE TABLE IF NOT EXISTS viability_enterprise_settings (
        company_id                   INTEGER PRIMARY KEY,
        blocked_considered_available INTEGER NOT NULL DEFAULT 0,
        marketing_dept_overrides     JSONB,
        status_override              VARCHAR(20),
        updated_by                   VARCHAR(120),
        created_at                   TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS status_override VARCHAR(20)`,

    // NOVO — governança "rascunho → liberado" por empreendimento.
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS is_released   BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS released_by   VARCHAR(120)`,
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS released_at   TIMESTAMP`,
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS release_notes TEXT`,

    // NOVO — relatório gerencial: bucket LOJA (deptos) + cache da narrativa IA.
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS loja_departments JSONB`,
    `ALTER TABLE viability_enterprise_settings ADD COLUMN IF NOT EXISTS report_insights  JSONB`,
];

export async function ensureDeptSpendingSchema() {
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
    console.log(`✅ [SchemaPatch] Gastos por Departamento schema garantido (${applied} OK, ${failed} skip).`);
}
