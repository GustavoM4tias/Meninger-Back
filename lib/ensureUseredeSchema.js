// lib/ensureUseredeSchema.js
//
// Schema do módulo Link de Cartão (Userede).
//
// Mesma disciplina do ensureBoletoSchema: idempotente, roda em todo boot, e
// cria a linha singleton de settings para a tela ter o que editar já no
// primeiro acesso (sem ela, o PATCH não acha o registro e a tela nasce quebrada).
import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS userede_settings (
        id SERIAL PRIMARY KEY,
        usuario TEXT,
        senha TEXT,
        session_state TEXT,
        session_valida_em TIMESTAMP WITH TIME ZONE,
        session_precisa_humano BOOLEAN NOT NULL DEFAULT FALSE,
        session_ultimo_erro VARCHAR(500),
        pv_principal VARCHAR(20) DEFAULT '18309232',
        idserie_credito TEXT DEFAULT '[]',
        valor_maximo DECIMAL(15,2) DEFAULT 15000,
        max_parcelas INTEGER NOT NULL DEFAULT 12,
        max_dias_vencimento INTEGER DEFAULT 5,
        cv_idtipo_documento INTEGER,
        situacao_sucesso_id INTEGER,
        situacao_erro_id INTEGER,
        situacao_pago_id INTEGER,
        active BOOLEAN DEFAULT FALSE,
        updated_by INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`,

    // Bases que já criaram a tabela antes destes campos existirem.
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_state TEXT`,
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_valida_em TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_precisa_humano BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE userede_settings ADD COLUMN IF NOT EXISTS session_ultimo_erro VARCHAR(500)`,
    `ALTER TABLE userede_settings ALTER COLUMN created_at SET DEFAULT NOW()`,
    `ALTER TABLE userede_settings ALTER COLUMN updated_at SET DEFAULT NOW()`,

    // Linha singleton — a tela edita sempre o id=1.
    `INSERT INTO userede_settings (id, created_at, updated_at)
          VALUES (1, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
];

export async function ensureUseredeSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch][Userede] ${err.message}`);
        }
    }
    console.log(`✅ [SchemaPatch] Userede schema garantido (${applied} OK, ${failed} skip).`);
}

export default ensureUseredeSchema;
