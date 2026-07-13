// scripts/add_lead_breakdown_columns.js
//
// Adiciona as colunas do desdobramento de leads Meta (formulário × pixel) de
// forma IDEMPOTENTE, via SQL direto — necessário enquanto SKIP_DB_SYNC=true
// estiver ativo no Railway (a fase de schema do boot é pulada). Rodar uma vez:
//   node scripts/add_lead_breakdown_columns.js
//
// Seguro re-rodar (tudo IF NOT EXISTS). Mesmo padrão do create_insights_daily.js.

import db from '../models/sequelize/index.js';

const SQL = `
ALTER TABLE meta_campaigns      ADD COLUMN IF NOT EXISTS meta_leads_form  INTEGER DEFAULT 0;
ALTER TABLE meta_campaigns      ADD COLUMN IF NOT EXISTS meta_leads_pixel INTEGER DEFAULT 0;
ALTER TABLE meta_insights_daily ADD COLUMN IF NOT EXISTS meta_leads_form  INTEGER DEFAULT 0;
ALTER TABLE meta_insights_daily ADD COLUMN IF NOT EXISTS meta_leads_pixel INTEGER DEFAULT 0;
`;

try {
    await db.sequelize.query(SQL);
    const [rows] = await db.sequelize.query(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name IN ('meta_leads_form','meta_leads_pixel')
        ORDER BY table_name, column_name`);
    console.log('✅ Colunas garantidas:');
    for (const r of rows) console.log(`   ${r.table_name}.${r.column_name}`);
    await db.sequelize.close();
    process.exit(0);
} catch (e) {
    console.error('❌ falha:', e.message);
    process.exit(1);
}
