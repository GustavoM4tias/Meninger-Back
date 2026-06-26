// lib/ensureOrganogramSchema.js
//
// Garante a tabela de ajustes do organograma + o índice único (user_id) que mantém
// 1 ajuste por pessoa. Idempotente — roda todo boot. O índice é criado aqui (não no
// model) para evitar o problema de índice novo no sync({ alter: true }).
// Ver models/sequelize/organogramOverride.js e organogramController.js.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS organogram_overrides (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER NOT NULL,
        display_parent_id INTEGER,
        display_order     INTEGER,
        pos_x             DOUBLE PRECISION,
        pos_y             DOUBLE PRECISION,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    // Remove qualquer FK herdada de boots anteriores — a linha-sentinela user_id=0
    // (posição do nó-raiz "empresa") não referencia nenhum usuário real.
    `DO $$
        DECLARE c record;
        BEGIN
            FOR c IN
                SELECT conname FROM pg_constraint
                WHERE conrelid = 'organogram_overrides'::regclass AND contype = 'f'
            LOOP
                EXECUTE 'ALTER TABLE organogram_overrides DROP CONSTRAINT ' || quote_ident(c.conname);
            END LOOP;
        END $$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_organogram_override_user
        ON organogram_overrides (user_id)`,
];

export async function ensureOrganogramSchema() {
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
    console.log(`✅ [SchemaPatch] Organogram schema garantido (${applied} OK, ${failed} skip).`);
}
