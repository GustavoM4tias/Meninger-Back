// lib/ensureComercialConditionsSchema.js
//
// Patch defensivo do schema das Fichas Comerciais.
//
// As tabelas `enterprise_conditions` e `comercial_settings` já estabilizaram
// (saíram da lista de sync({ alter: true })), então colunas novas precisam ser
// adicionadas aqui de forma idempotente. Cobre a migração que:
//   - troca os aprovadores fixos (approver_1_id/approver_2_id) por listas de
//     permissão configuráveis (quem pode editar / quem pode autorizar);
//   - adiciona `series_id` para a auto-geração mensal das fichas avulsas (sem CV),
//     que antes não evoluíam automaticamente;
//   - adiciona o pagador uniforme por item de custo (itbi/cca/cert _paid_by) no
//     módulo e o pagador da campanha, com backfill a partir do modelo legado.
//
// Idempotente — pode rodar em todo boot.
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // Linhagem das fichas avulsas (idempreendimento null) para auto-geração mensal.
    `ALTER TABLE enterprise_conditions ADD COLUMN IF NOT EXISTS series_id INTEGER`,

    // Índice de série: scheduler e controller filtram/agrupam muito por series_id.
    `CREATE INDEX IF NOT EXISTS idx_enterprise_conditions_series_id ON enterprise_conditions (series_id)`,

    // Unicidade da ficha avulsa por (série, mês): fecha a brecha de duplicação na
    // auto-geração das avulsas (as fichas COM CV já têm unique (idempreendimento, reference_month)).
    // Índice PARCIAL (só quando series_id não é nulo). Se houver duplicatas legadas o
    // CREATE falha e é apenas logado pelo try/catch abaixo: NUNCA apaga dados.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_enterprise_conditions_series_month ON enterprise_conditions (series_id, reference_month) WHERE series_id IS NOT NULL`,

    // Listas de permissão (substituem approver_1_id / approver_2_id).
    `ALTER TABLE comercial_settings ADD COLUMN IF NOT EXISTS editor_user_ids JSONB DEFAULT '[]'::jsonb`,
    `ALTER TABLE comercial_settings ADD COLUMN IF NOT EXISTS authorizer_user_ids JSONB DEFAULT '[]'::jsonb`,

    // ── Modelo de custo uniforme: pagador por item (Menin x cliente) ───────────
    // CEF e cartório já tinham *_paid_by; aqui completamos ITBI, CCA e certificação
    // no módulo, e o pagador opcional da campanha (null = não é custo rastreado).
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS itbi_paid_by VARCHAR(20)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS cca_paid_by VARCHAR(20)`,
    `ALTER TABLE enterprise_condition_modules ADD COLUMN IF NOT EXISTS digital_cert_paid_by VARCHAR(20)`,
    `ALTER TABLE enterprise_condition_campaigns ADD COLUMN IF NOT EXISTS paid_by VARCHAR(20)`,

    // Backfill idempotente do pagador a partir do modelo legado (só onde ainda nulo).
    // Preserva exatamente o comportamento atual de custo enquanto canoniza no campo novo.
    `UPDATE enterprise_condition_modules SET cca_paid_by = 'menin' WHERE cca_paid_by IS NULL AND cca_charges_company = true`,
    `UPDATE enterprise_condition_modules SET digital_cert_paid_by = 'menin' WHERE digital_cert_paid_by IS NULL AND digital_cert_has_cost = true`,
    `UPDATE enterprise_condition_modules SET itbi_paid_by = 'client' WHERE itbi_paid_by IS NULL AND itbi_avg_value IS NOT NULL AND itbi_avg_value > 0`,
];

export async function ensureComercialConditionsSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Comercial] ${err.message}`);
        }
    }
    console.log(`✅ [SchemaPatch] Fichas Comerciais schema garantido (${applied} OK, ${failed} skip).`);
}
