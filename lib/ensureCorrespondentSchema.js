// lib/ensureCorrespondentSchema.js
//
// Patch defensivo do módulo de Correspondentes.
//
// `celular` nasceu no model quando se descobriu que o POST do CV aceita o campo
// (medido em 04/08/2026 cadastrando a equipe da IMPAV), mas nunca entrou no
// banco: o módulo não tinha arquivo ensure, e o sync({ alter }) é pulado pelo
// gate de fingerprint quando nada mais muda.
//
// O sintoma era o pior tipo: o [SchemaDrift] do boot acusava
// CorrespondentRegistration e TODA query nesse model falhava com
// "column celular does not exist" - a tela de Correspondentes quebrada em
// silêncio, sem ninguém relacionar com a coluna.
//
// Idempotente — roda em todo boot.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `ALTER TABLE correspondent_registrations ADD COLUMN IF NOT EXISTS celular VARCHAR(40)`,
];

export async function ensureCorrespondentSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Correspondentes] ${err.message}`);
        }
    }
    console.log(`🧩 [SchemaPatch][Correspondentes] ${applied} ok, ${failed} falha(s).`);
}

export default ensureCorrespondentSchema;
