// lib/ensureMetaAccountBindingSchema.js
//
// Schema do vínculo por conta de anúncio + colunas de marketing que o gate de
// schema deixou de fora em produção (2026-09-16).
//
// Roda FORA do gate (initBackground, antes da fase de schema) e também na
// lista de patches (banco novo). Motivo medido em 15/09/2026: o model
// CvLeadQueue declara `rodizio_pos` desde 28/08, mas a coluna nunca nasceu em
// prod (fingerprint igual / SKIP_DB_SYNC) - toda query da fila quebrava com
// "column rodizio_pos does not exist", o despacho de lead reentrada com 2o
// interesse abortava ANTES do save e o scheduler o repetia a cada 3 min
// (21 leads presos desde 30/08, 98 mil eventos de loop). Idempotente e barato.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    // Rodízio do Office nas filas do CV (commit 2438f86, 28/08/2026).
    `ALTER TABLE cv_lead_queues ADD COLUMN IF NOT EXISTS rodizio_pos INTEGER`,

    // Vínculo padrão por conta de anúncio.
    `CREATE TABLE IF NOT EXISTS meta_ad_account_bindings (
        account_id            VARCHAR(40) PRIMARY KEY,
        account_name          VARCHAR(255),
        bound_empreendimentos JSONB,
        midia_slug            VARCHAR(60),
        cv_origem             VARCHAR(4),
        tags                  JSONB,
        mapping_active        BOOLEAN NOT NULL DEFAULT true,
        notes                 TEXT,
        definido_por          INTEGER,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Conta/campanha "fora do CV" (17/09/2026): lead vira ignored, não held.
    `ALTER TABLE meta_ad_account_bindings ADD COLUMN IF NOT EXISTS cv_skip BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE meta_campaigns            ADD COLUMN IF NOT EXISTS cv_skip BOOLEAN DEFAULT false`,

    // Mídia/origem padrão do vínculo (Configurações da Central Meta).
    `ALTER TABLE marketing_configs ADD COLUMN IF NOT EXISTS meta_default_midia_slug VARCHAR(60) NOT NULL DEFAULT 'Facebook Ads'`,
    `ALTER TABLE marketing_configs ADD COLUMN IF NOT EXISTS meta_default_cv_origem  VARCHAR(4)  NOT NULL DEFAULT 'FB'`,

    // Formulário "só cadastro" + lista pública para telão (24/09/2026, sorteio do meeting).
    `ALTER TABLE lead_forms ADD COLUMN IF NOT EXISTS cv_skip     BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE lead_forms ADD COLUMN IF NOT EXISTS public_feed BOOLEAN NOT NULL DEFAULT false`,
];

export async function ensureMetaAccountBindingSchema() {
    let ok = 0, falhas = 0;
    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); ok++; }
        catch (err) {
            // Tabela ainda não existe (banco novo): o sync do model a cria já com a coluna.
            falhas++;
            console.warn(`⚠️  [SchemaPatch][MetaAccountBinding] ${err.message} — SQL: ${sql.slice(0, 70)}`);
        }
    }
    console.log(`✅ [SchemaPatch][MetaAccountBinding] vínculo por conta + rodizio_pos garantidos (${ok} OK, ${falhas} skip).`);
}

export default ensureMetaAccountBindingSchema;
