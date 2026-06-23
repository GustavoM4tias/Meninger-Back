// lib/ensureDepartmentVisibilitySchema.js
//
// Garante a tabela de overrides de visibilidade de departamento (cargo/usuário) + o
// índice único usado pelo upsert (ON CONFLICT). Idempotente — roda todo boot.
// O índice é criado aqui (não no model) para evitar o problema de índice novo no
// sync({ alter: true }). O nível GLOBAL continua em expense_department_visibility.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS department_visibility_overrides (
        id              SERIAL PRIMARY KEY,
        scope           VARCHAR(20)  NOT NULL,
        scope_key       VARCHAR(120) NOT NULL,
        department_name VARCHAR(120) NOT NULL,
        hidden          BOOLEAN      NOT NULL DEFAULT true,
        updated_by      VARCHAR(120),
        created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_dept_vis_override
        ON department_visibility_overrides (scope, scope_key, department_name)`,
];

export async function ensureDepartmentVisibilitySchema() {
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
    console.log(`✅ [SchemaPatch] Department-visibility schema garantido (${applied} OK, ${failed} skip).`);
}
