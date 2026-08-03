// lib/ensureEventPlanSchema.js
//
// Colunas do Plano de Eventos que entraram DEPOIS da criação das tabelas.
// Idempotente, roda todo boot.
//
// Contexto: `event_plan_settings` nasceu no primeiro boot do módulo e ganhou
// `auto_submit_enabled` no envio automático (F3). O gate de schema pulou o
// sync({ alter }) daquele deploy, então a coluna ficou só no model - e como o
// service lê as settings em quase tudo (abrir plano, criar evento, consolidado),
// a tela inteira respondia 500 "Falha ao carregar o plano". Patch explícito
// para nunca mais depender do alter ter rodado.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `ALTER TABLE event_plan_settings
        ADD COLUMN IF NOT EXISTS auto_submit_enabled BOOLEAN NOT NULL DEFAULT true`,
];

export async function ensureEventPlanSchema() {
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
    console.log(`✅ [SchemaPatch] Plano de Eventos garantido (${applied} OK, ${failed} skip).`);
}

export default ensureEventPlanSchema;
