// lib/ensureRepasseIndexes.js
//
// Índice de `repasses.idreserva`.
//
// O relatório de Reservas passou a buscar o repasse mais recente de cada
// reserva (LEFT JOIN LATERAL por idreserva) para mostrar a situação do repasse
// e o link do CV. Sem índice, cada linha varria a tabela inteira: medido em
// 2026-08-20, 557 reservas levavam ~250ms só no laço, e o custo cresce junto
// com o período filtrado.
//
// Vive aqui, e não no array `indexes` do model, porque `sync({ alter: true })`
// tenta criar índice novo antes da coluna existir e derruba o boot. Índice
// novo no projeto entra sempre por um ensure* idempotente.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE INDEX IF NOT EXISTS repasses_idreserva ON repasses (idreserva)`,
];

export async function ensureRepasseIndexes() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][RepasseIndexes] ${err.message}`);
        }
    }
    console.log(`✅ [SchemaPatch] Repasse indexes garantidos (${applied} OK, ${failed} skip).`);
}

export default ensureRepasseIndexes;
