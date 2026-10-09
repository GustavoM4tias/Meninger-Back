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
import { seedSalesStandExpenseCategories } from '../services/marketing/salesStandExpenseService.js';

const MENSAIS = ['Aluguel', 'Energia elétrica', 'Água e esgoto', 'Telefone e internet'];

const STATEMENTS = [
    `ALTER TABLE IF EXISTS sales_stands ADD COLUMN IF NOT EXISTS opened_at DATE`,
    `ALTER TABLE IF EXISTS sales_stand_expense_categories
        ADD COLUMN IF NOT EXISTS expected_monthly BOOLEAN NOT NULL DEFAULT false`,
    // Classificação automática (09/10): janela de montagem e regras por palavra.
    `ALTER TABLE IF EXISTS sales_stand_settings ADD COLUMN IF NOT EXISTS assembly_days INTEGER NOT NULL DEFAULT 35`,
    `ALTER TABLE IF EXISTS sales_stand_settings ADD COLUMN IF NOT EXISTS auto_rules JSONB`,
    // Conferência ao vivo (09/10): o departamento que a API do Sienge devolveu
    // para cada título, para o relatório usar antes da próxima carga do espelho.
    `CREATE TABLE IF NOT EXISTS sales_stand_live_fixes (
        bill_id         INTEGER      PRIMARY KEY,
        cost_center_id  INTEGER,
        has_stand       BOOLEAN      NOT NULL DEFAULT false,
        stand_pct       NUMERIC(7,3) NOT NULL DEFAULT 0,
        departments     JSONB        NOT NULL DEFAULT '[]'::jsonb,
        checked_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        checked_by      INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS sales_stand_live_fixes_cc_idx ON sales_stand_live_fixes (cost_center_id)`,
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
    // Categorias padrão novas e as contas Adm/Obra equivalentes às do stand.
    // Também roda no seed do gate; aqui garante que valha mesmo com o gate pulando.
    await seedSalesStandExpenseCategories();
}

export default ensureSalesStandReportSchema;
