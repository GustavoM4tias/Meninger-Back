// lib/schemaDriftCheck.js
//
// Avisa no boot quando um model declara coluna que NÃO existe no banco.
//
// Por que existe: o projeto evolui schema por sync({alter}) + patches ensure*,
// e o sync global do boot roda com alter:false (cria tabela nova, mas não
// adiciona coluna em tabela existente). Quando alguém acrescenta um campo ao
// model e esquece o ALTER correspondente no ensure*, a coluna nunca nasce — e
// TODA query daquele model passa a morrer com "column X does not exist".
//
// O pior é o sintoma: não estoura no boot, estoura depois, numa tela qualquer,
// como erro genérico. Já aconteceu com cv_workflow_groups.stale_days e com
// eme_generated_reports.briefing (que fazia a Eme responder "o construtor de
// relatórios está com instabilidade").
//
// Este check não corrige nada — só compara e reclama alto, com o nome do model,
// da tabela e da coluna. Uma query, roda no fim da fase de schema.

import db from '../models/sequelize/index.js';

export async function schemaDriftCheck() {
    try {
        const rows = await db.sequelize.query(
            `SELECT table_name, column_name
               FROM information_schema.columns
              WHERE table_schema = 'public'`,
            { type: db.Sequelize.QueryTypes.SELECT }
        );

        // table -> Set(colunas)
        const byTable = new Map();
        for (const r of rows) {
            if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
            byTable.get(r.table_name).add(r.column_name);
        }

        const drifts = [];
        for (const [modelName, model] of Object.entries(db)) {
            if (!model?.getTableName || !model?.rawAttributes) continue;

            const table = typeof model.getTableName() === 'string'
                ? model.getTableName()
                : model.getTableName()?.tableName;
            if (!table) continue;

            const existing = byTable.get(table);
            if (!existing) continue; // tabela não existe ainda: outro problema, não drift

            const missing = Object.values(model.rawAttributes)
                .map(a => a.field)
                .filter(f => f && !existing.has(f));

            if (missing.length) drifts.push({ modelName, table, missing });
        }

        if (!drifts.length) {
            console.log('✅ [SchemaDrift] Nenhuma coluna faltando: models e banco batem.');
            return;
        }

        console.error(`❌ [SchemaDrift] ${drifts.length} model(s) com coluna declarada que NÃO existe no banco.`);
        console.error('    Toda query nesses models vai falhar. Adicione o ALTER TABLE ... ADD COLUMN IF NOT EXISTS no ensure* do módulo.');
        for (const d of drifts) {
            console.error(`    • ${d.modelName} (${d.table}): ${d.missing.join(', ')}`);
        }
    } catch (err) {
        console.warn(`⚠️  [SchemaDrift] Verificação falhou (não crítico): ${err.message}`);
    }
}
