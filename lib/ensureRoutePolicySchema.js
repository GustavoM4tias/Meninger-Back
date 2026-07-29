// lib/ensureRoutePolicySchema.js
//
// Schema das políticas de tela definidas pelo admin em /settings/permissions:
//
//   route_policies                       — telas travadas como "somente admin"
//                                          sem deploy (ver models/routePolicy.js).
//   permission_profiles.seed_code        — perfil PADRÃO gerado pelo sistema
//                                          (código do departamento).
//   permission_profiles.routes_customized— true depois que o admin editou as
//                                          telas do perfil: a partir daí o seed
//                                          padrão nunca mais mexe nas rotas.
//
// Roda cedo (fase de ADD COLUMN): os models PermissionProfile/RoutePolicy já
// declaram essas colunas, e sem elas qualquer query da tela de Alçadas quebra.
// Idempotente (IF NOT EXISTS) — roda a cada boot sem efeito colateral.

import db from '../models/sequelize/index.js';

export async function ensureRoutePolicySchema() {
    const q = (sql) => db.sequelize.query(sql);

    await q(`
        CREATE TABLE IF NOT EXISTS route_policies (
            id          SERIAL PRIMARY KEY,
            route       VARCHAR(200) NOT NULL UNIQUE,
            admin_only  BOOLEAN NOT NULL DEFAULT true,
            note        TEXT NULL,
            updated_by  INTEGER NULL REFERENCES users(id),
            created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
    `);

    // permission_profiles pode ainda não existir num banco novo (o sync cria
    // depois) — mesmo cuidado do ensureSignupApprovalColumns.
    await q(`
        DO $$
        BEGIN
            IF to_regclass('public.permission_profiles') IS NOT NULL THEN
                ALTER TABLE permission_profiles
                    ADD COLUMN IF NOT EXISTS seed_code VARCHAR(60) NULL;
                ALTER TABLE permission_profiles
                    ADD COLUMN IF NOT EXISTS routes_customized BOOLEAN NOT NULL DEFAULT false;
            END IF;
        END $$;
    `);

    console.log('✅ [SchemaPatch] Políticas de tela garantidas (route_policies + perfis padrão).');
}

export default ensureRoutePolicySchema;
