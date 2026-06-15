// lib/ensureEmeBrainSchema.js
//
// Rede de segurança do "Cérebro da Eme" (Brain Studio): garante que as tabelas
// de configuração existam mesmo quando o sync({ alter:false }) do boot não as
// criar (ex.: interrupção por ECONNRESET em ALTER/CREATE remoto).
//
// As tabelas normalmente nascem dos models (models/sequelize/eme/*) no sync do
// boot; este patch é só o "caso falhe". Idempotente — usa IF NOT EXISTS em tudo
// e pode rodar a cada boot sem efeito colateral. Espelha exatamente os models.
//
// Padrão estabelecido no projeto — ver ensureBillsAutoSyncSchema.js.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
  // ── eme_prompt_blocks ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_prompt_blocks (
      id                   UUID PRIMARY KEY,
      key                  VARCHAR(120) NOT NULL UNIQUE,
      title                VARCHAR(200) NOT NULL,
      category             VARCHAR(40)  NOT NULL DEFAULT 'custom',
      module               VARCHAR(60),
      context              VARCHAR(20)  NOT NULL DEFAULT 'OFFICE',
      content              TEXT         NOT NULL DEFAULT '',
      order_index          INTEGER      NOT NULL DEFAULT 0,
      enabled              BOOLEAN      NOT NULL DEFAULT true,
      is_dynamic           BOOLEAN      NOT NULL DEFAULT false,
      required_permission  VARCHAR(120),
      locked               BOOLEAN      NOT NULL DEFAULT false,
      updated_by           VARCHAR(120),
      created_at           TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMP    NOT NULL DEFAULT NOW()
  )`,

  // ── eme_glossary_terms ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_glossary_terms (
      id           UUID PRIMARY KEY,
      key          VARCHAR(140) NOT NULL UNIQUE,
      term         VARCHAR(200) NOT NULL,
      canonical    VARCHAR(200),
      kind         VARCHAR(30)  NOT NULL DEFAULT 'vocabulary',
      context      VARCHAR(20)  NOT NULL DEFAULT 'OFFICE',
      note         TEXT,
      enabled      BOOLEAN      NOT NULL DEFAULT true,
      updated_by   VARCHAR(120),
      created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMP    NOT NULL DEFAULT NOW()
  )`,

  // ── eme_reports ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_reports (
      id                   UUID PRIMARY KEY,
      name                 VARCHAR(80) NOT NULL UNIQUE,
      label                VARCHAR(200),
      kind                 VARCHAR(20) NOT NULL DEFAULT 'builtin',
      enabled              BOOLEAN     NOT NULL DEFAULT true,
      description          TEXT,
      prompt_rules         TEXT,
      params_config        JSONB,
      data_source          VARCHAR(60),
      definition           JSONB,
      required_permission  VARCHAR(120),
      admin_only           BOOLEAN     NOT NULL DEFAULT false,
      super_admin_only     BOOLEAN     NOT NULL DEFAULT false,
      contexts             JSONB       NOT NULL DEFAULT '["OFFICE"]'::jsonb,
      updated_by           VARCHAR(120),
      created_at           TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  // ── eme_settings ───────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_settings (
      id           UUID PRIMARY KEY,
      key          VARCHAR(80) NOT NULL UNIQUE,
      value        JSONB       NOT NULL DEFAULT '{}'::jsonb,
      updated_by   VARCHAR(120),
      created_at   TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  // ── eme_config_versions ────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_config_versions (
      id            UUID PRIMARY KEY,
      label         VARCHAR(200),
      payload       JSONB       NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'published',
      is_active     BOOLEAN     NOT NULL DEFAULT false,
      published_by  VARCHAR(120),
      note          TEXT,
      created_at    TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  // Índices úteis (idempotentes). Em geral já vêm dos models no sync; recriados
  // aqui só para o caso de a tabela ter nascido por este patch (sync falho).
  `CREATE INDEX IF NOT EXISTS eme_prompt_blocks_context_idx   ON eme_prompt_blocks (context)`,
  `CREATE INDEX IF NOT EXISTS eme_prompt_blocks_order_idx      ON eme_prompt_blocks (order_index)`,
  `CREATE INDEX IF NOT EXISTS eme_glossary_terms_kind_idx      ON eme_glossary_terms (kind)`,
  `CREATE INDEX IF NOT EXISTS eme_reports_kind_idx             ON eme_reports (kind)`,
  `CREATE INDEX IF NOT EXISTS eme_config_versions_active_idx   ON eme_config_versions (is_active)`,
];

export async function ensureEmeBrainSchema() {
  let applied = 0;
  let failed = 0;
  for (const sql of STATEMENTS) {
    try {
      await db.sequelize.query(sql);
      applied++;
    } catch (err) {
      failed++;
      console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
      console.warn(`    SQL: ${sql.slice(0, 100)}...`);
    }
  }
  console.log(`✅ [SchemaPatch] Cérebro da Eme schema garantido (${applied} OK, ${failed} skip).`);
}
