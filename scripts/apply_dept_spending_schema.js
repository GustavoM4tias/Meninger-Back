// scripts/apply_dept_spending_schema.js
//
// Aplica AGORA o schema de "Gastos por Departamento" (colunas de liberação em
// viability_enterprise_settings + tabelas/colunas mantidas), sem depender do
// gate de schema do boot. Rode: `node scripts/apply_dept_spending_schema.js`.
import db from '../models/sequelize/index.js';
import { ensureDeptSpendingSchema } from '../lib/ensureDeptSpendingSchema.js';

(async () => {
    try {
        await db.sequelize.authenticate();
        await ensureDeptSpendingSchema();
        console.log('✅ Schema de Gastos por Departamento aplicado.');
        process.exit(0);
    } catch (e) {
        console.error('❌ Falha ao aplicar schema:', e.message);
        process.exit(1);
    }
})();
