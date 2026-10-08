// lib/ensureSalesStandReportSchema.js
//
// RELATÓRIO DO STAND DE VENDAS (08/10/2026). Duas colunas entraram nos models:
//
//   sales_stands.opened_at                       inauguração do stand
//   sales_stand_expense_categories.expected_monthly  conta que vence todo mês
//
// Roda FORA do gate de schema: a tela do stand lê as duas na primeira chamada,
// e com o gate pulando a fase em prod elas nunca nasceriam.
//
// Os backfills são idempotentes:
//   - opened_at sai do texto "Inaugurado em dd/mm/aaaa" que já estava nas
//     observações de cada stand, só onde ainda está vazio;
//   - expected_monthly liga para as contas fixas do stand nas categorias que
//     ninguém editou na tela (updated_by nulo). Editada, fica como a pessoa deixou.

import db from '../models/sequelize/index.js';

const MENSAIS = ['Aluguel', 'Energia elétrica', 'Água e esgoto', 'Telefone e internet'];

const STATEMENTS = [
    `ALTER TABLE IF EXISTS sales_stands ADD COLUMN IF NOT EXISTS opened_at DATE`,
    `ALTER TABLE IF EXISTS sales_stand_expense_categories
        ADD COLUMN IF NOT EXISTS expected_monthly BOOLEAN NOT NULL DEFAULT false`,
    String.raw`UPDATE sales_stands
        SET opened_at = to_date(substring(notes from 'Inaugurad[oa] em (\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY')
      WHERE opened_at IS NULL
        AND notes ~ 'Inaugurad[oa] em \d{2}/\d{2}/\d{4}'`,
];

export async function ensureSalesStandReportSchema() {
    const [[existe]] = await db.sequelize.query(
        `SELECT to_regclass('public.sales_stands') IS NOT NULL AS ok`,
    );
    if (!existe?.ok) return; // banco novo: o sync cria a tabela já com as colunas
    for (const sql of STATEMENTS) {
        await db.sequelize.query(sql);
    }
    await db.sequelize.query(
        `UPDATE sales_stand_expense_categories
            SET expected_monthly = true
          WHERE name IN (:nomes) AND updated_by IS NULL AND expected_monthly = false`,
        { replacements: { nomes: MENSAIS } },
    );
}

export default ensureSalesStandReportSchema;
