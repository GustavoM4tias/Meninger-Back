// lib/ensureRecursoProprioSchema.js
//
// Relatório de Recurso Próprio por cliente (/comercial/relatorios/recurso-proprio).
// Idempotente, roda todo boot FORA do gate de schema: a tela consulta as duas
// tabelas na primeira chamada e, com o gate pulando a fase em prod, elas nunca
// nasceriam.
//
// - recurso_proprio_settings: singleton (id = 1) com a configuração do
//   relatório em JSONB. Os defaults moram em services/comercial/recursoProprioService.js
//   e só valem para a chave que a tela nunca gravou.
// - recurso_proprio_notas: observação por reserva (o tooltip do relatório do
//   Ingá: "tem proposta para quitação", "será apresentado um fiador").

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS recurso_proprio_settings (
        id          INTEGER PRIMARY KEY,
        config      JSONB        NOT NULL DEFAULT '{}'::jsonb,
        updated_by  INTEGER,
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,
    `INSERT INTO recurso_proprio_settings (id, config) VALUES (1, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS recurso_proprio_notas (
        idreserva   INTEGER PRIMARY KEY,
        texto       TEXT         NOT NULL,
        tom         VARCHAR(10)  NOT NULL DEFAULT 'alerta',
        updated_by  INTEGER,
        updated_by_name VARCHAR(160),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,
];

export async function ensureRecursoProprioSchema() {
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch] Recurso próprio: ${err.message}`);
        }
    }
    if (!failed) console.log('✅ [SchemaPatch] Recurso próprio');
}

export default ensureRecursoProprioSchema;
