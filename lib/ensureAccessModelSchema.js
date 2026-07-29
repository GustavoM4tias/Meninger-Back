// lib/ensureAccessModelSchema.js
//
// Patches do modelo de acesso "perfil vivo + exceções + grants por
// empreendimento" (spec em _estudo/acessos/README.md):
//
//   1. Backfill ÚNICO das alçadas legadas: user_permissions.routes →
//      routes_extra (marcado por routes_migrated). Garante que ninguém perde
//      alçada de TELA na virada. As colunas em si nascem do sync({alter}).
//   2. Consolidação inicial do registro unificado (companies/enterprises) em
//      background — não bloqueia o boot.

import db from '../models/sequelize/index.js';
import { consolidateRegistry } from '../services/org/enterpriseRegistryService.js';

export async function ensureAccessModelSchema() {
    // 1) Backfill routes → routes_extra (uma única vez por linha)
    const [migrated] = await db.sequelize.query(`
        UPDATE user_permissions
           SET routes_extra = routes,
               routes_migrated = true
         WHERE routes_migrated = false
           AND routes IS NOT NULL
           AND routes::text NOT IN ('[]', 'null')
    `);
    // Linhas vazias também são marcadas para não reprocessar
    await db.sequelize.query(`
        UPDATE user_permissions SET routes_migrated = true WHERE routes_migrated = false
    `);
    const n = Array.isArray(migrated) ? migrated.length : (migrated?.rowCount ?? 0);
    if (n) console.log(`✅ [SchemaPatch] Alçadas legadas copiadas para routes_extra: ${n} usuário(s).`);

    // 2) Consolidação do registro unificado — background (fontes podem estar
    //    vazias no primeiro boot; os syncs da tela populam depois).
    consolidateRegistry().catch(err =>
        console.warn('⚠️  [orgRegistry] consolidação no boot falhou:', err?.message || err)
    );
}

export default ensureAccessModelSchema;
