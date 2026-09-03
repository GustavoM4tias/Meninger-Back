// lib/ensureRepasseIndexes.js
//
// Índices que o relatório de Reservas precisa (e o vigia do envio ao ERP).
//
// O relatório de Reservas passou a buscar o repasse mais recente de cada
// reserva (LEFT JOIN LATERAL por idreserva) para mostrar a situação do repasse
// e o link do CV. Sem índice, cada linha varria a tabela inteira: medido em
// 2026-08-20, 557 reservas levavam ~250ms só no laço, e o custo cresce junto
// com o período filtrado.
//
// 2026-09-02: o mesmo laço existe para `boleto_history` (a entrada da reserva
// em Envio Sienge, que alimenta o triângulo de travada para o ERP) e a
// listagem filtra e ordena por `reservas.data_reserva`. Sem os dois índices, a
// consulta de oito meses lia 84 mil páginas do histórico de boletos e varria
// a tabela de reservas inteira.
//
// Vive aqui, e não no array `indexes` do model, porque `sync({ alter: true })`
// tenta criar índice novo antes da coluna existir e derruba o boot. Índice
// novo no projeto entra sempre por um ensure* idempotente.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE INDEX IF NOT EXISTS repasses_idreserva ON repasses (idreserva)`,
    // "Repasse mais recente da reserva" (ORDER BY idrepasse DESC LIMIT 1): com o
    // indice simples o planejador andava a chave primaria inteira de tras para
    // frente; o composto responde com uma pagina.
    `CREATE INDEX IF NOT EXISTS repasses_idreserva_idrepasse ON repasses (idreserva, idrepasse DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_boleto_history_idreserva ON boleto_history (idreserva)`,
    `CREATE INDEX IF NOT EXISTS reservas_data_reserva ON reservas (data_reserva DESC)`,
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
