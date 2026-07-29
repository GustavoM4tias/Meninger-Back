// lib/ensureAccessModelColumns.js
//
// ADD COLUMN das colunas novas do modelo de acesso em TABELAS ESTÁVEIS.
// O boot roda db.sequelize.sync({ alter: false }) — cria tabela nova mas NUNCA
// altera tabela existente. Toda coluna nova em users/user_permissions/positions
// precisa deste DDL explícito (mesmo padrão do ensureSignupApprovalColumns).
//
// ⚠️ Roda NO INÍCIO da fase de schema (antes dos demais patches): enquanto a
// coluna não existe, QUALQUER query dos models User/UserPermission/Position
// quebra com "column X does not exist" — inclusive o login Microsoft.
//
// Idempotente (IF NOT EXISTS) — roda a cada boot sem efeito colateral.

import db from '../models/sequelize/index.js';

export async function ensureAccessModelColumns() {
    const q = (sql) => db.sequelize.query(sql);

    // users — FKs estruturadas + perfil vivo
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position_id INTEGER REFERENCES positions(id);`);
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city_id INTEGER REFERENCES user_cities(id);`);
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_profile_id INTEGER REFERENCES permission_profiles(id);`);

    // user_permissions — exceções do perfil vivo
    await q(`ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS routes_extra JSON NOT NULL DEFAULT '[]';`);
    await q(`ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS routes_removed JSON NOT NULL DEFAULT '[]';`);
    await q(`ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS routes_migrated BOOLEAN NOT NULL DEFAULT false;`);

    // positions — nível hierárquico
    await q(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS level INTEGER;`);

    console.log('✅ [SchemaPatch] Colunas do modelo de acesso garantidas (users/user_permissions/positions).');
}

export default ensureAccessModelColumns;
