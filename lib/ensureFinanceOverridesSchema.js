// lib/ensureFinanceOverridesSchema.js
//
// Patch defensivo (idempotente) das tabelas de personalização do Financeiro que
// PERMANECEM após a remoção do bills auto-sync (Títulos/Custos agora leem ao vivo
// do backup do Sienge):
//   - cost_center_overrides        → nome de exibição do empreendimento (admin)
//   - expense_department_visibility → nível GLOBAL da visibilidade de departamentos
// (o nível cargo/usuário fica em ensureDepartmentVisibilitySchema.js)
//
// Mantém também correções gerais da tabela `favorites` que viviam no antigo
// ensureBillsAutoSyncSchema. Usa IF NOT EXISTS — pode rodar todo boot.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // favorites — corrige created_at sem default + amplia router/section para 120
    `ALTER TABLE favorites ALTER COLUMN created_at SET DEFAULT NOW()`,
    `ALTER TABLE favorites ALTER COLUMN router TYPE VARCHAR(120)`,
    `ALTER TABLE favorites ALTER COLUMN section TYPE VARCHAR(120)`,

    // cost_center_overrides — admin sobrepõe o nome exibido do empreendimento
    `CREATE TABLE IF NOT EXISTS cost_center_overrides (
        cost_center_id INTEGER PRIMARY KEY,
        display_name   VARCHAR(200) NOT NULL,
        updated_by     VARCHAR(120),
        created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )`,

    // expense_department_visibility — nível global do filtro de departamentos
    `CREATE TABLE IF NOT EXISTS expense_department_visibility (
        name        VARCHAR(120) PRIMARY KEY,
        hidden      BOOLEAN NOT NULL DEFAULT false,
        updated_by  VARCHAR(120),
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
];

export async function ensureFinanceOverridesSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
        }
    }
    console.log(`✅ [SchemaPatch] Finance overrides schema garantido (${applied} OK, ${failed} skip).`);
}
