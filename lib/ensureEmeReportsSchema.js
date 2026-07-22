// lib/ensureEmeReportsSchema.js
//
// Rede de segurança do módulo Relatórios da Eme (relatórios customizados
// gerados por IA): garante que as tabelas eme_generated_* existam mesmo quando
// o sync({ alter:false }) do boot não as criar. Idempotente — IF NOT EXISTS em
// tudo, espelha exatamente os models em models/sequelize/emeReports/.
//
// Padrão estabelecido no projeto — ver ensureEmeBrainSchema.js.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
  // ── eme_generated_reports ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_generated_reports (
      id                 UUID PRIMARY KEY,
      owner_id           INTEGER      NOT NULL REFERENCES users(id),
      title              VARCHAR(200) NOT NULL DEFAULT 'Novo relatório',
      enterprise_name    VARCHAR(200),
      status             VARCHAR(20)  NOT NULL DEFAULT 'draft',
      data_mode          VARCHAR(10)  NOT NULL DEFAULT 'fixed',
      period_start       DATE,
      period_end         DATE,
      visibility         VARCHAR(20)  NOT NULL DEFAULT 'private',
      public_token       VARCHAR(64)  UNIQUE,
      public_expires_at  TIMESTAMP,
      public_views       INTEGER      NOT NULL DEFAULT 0,
      spec               JSONB        NOT NULL DEFAULT '{"version":1,"blocks":[]}'::jsonb,
      data_snapshot      JSONB,
      refreshed_at       TIMESTAMP,
      published_version  INTEGER,
      published_at       TIMESTAMP,
      created_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMP    NOT NULL DEFAULT NOW()
  )`,

  // ── eme_generated_report_versions ──────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_generated_report_versions (
      id             UUID PRIMARY KEY,
      report_id      UUID      NOT NULL REFERENCES eme_generated_reports(id),
      version        INTEGER   NOT NULL,
      spec           JSONB     NOT NULL,
      data_snapshot  JSONB,
      published_by   INTEGER,
      published_at   TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // ── eme_generated_report_messages ──────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_generated_report_messages (
      id          UUID PRIMARY KEY,
      report_id   UUID        NOT NULL REFERENCES eme_generated_reports(id),
      role        VARCHAR(10) NOT NULL,
      content     TEXT        NOT NULL DEFAULT '',
      tool_calls  JSONB,
      created_at  TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  // ── eme_generated_report_access ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_generated_report_access (
      id          UUID PRIMARY KEY,
      report_id   UUID NOT NULL REFERENCES eme_generated_reports(id),
      user_id     INTEGER,
      position    VARCHAR(120),
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // ── eme_generated_report_public_log ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_generated_report_public_log (
      id          UUID PRIMARY KEY,
      report_id   UUID NOT NULL REFERENCES eme_generated_reports(id),
      ip          VARCHAR(64),
      user_agent  VARCHAR(400),
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // ── eme_generated_report_custom_blocks ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS eme_generated_report_custom_blocks (
      id              UUID PRIMARY KEY,
      content_hash    VARCHAR(64)  NOT NULL UNIQUE,
      html            TEXT         NOT NULL,
      purpose         VARCHAR(400),
      use_count       INTEGER      NOT NULL DEFAULT 1,
      last_report_id  UUID,
      status          VARCHAR(20)  NOT NULL DEFAULT 'em_uso',
      review_note     TEXT,
      created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
  )`,

  // Índices (idempotentes; em geral já nascem dos models no sync)
  `CREATE INDEX IF NOT EXISTS eme_generated_reports_owner_idx      ON eme_generated_reports (owner_id)`,
  `CREATE INDEX IF NOT EXISTS eme_generated_reports_status_idx     ON eme_generated_reports (status)`,
  `CREATE INDEX IF NOT EXISTS eme_generated_reports_visibility_idx ON eme_generated_reports (visibility)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS eme_generated_report_versions_uq ON eme_generated_report_versions (report_id, version)`,
  `CREATE INDEX IF NOT EXISTS eme_generated_report_messages_idx    ON eme_generated_report_messages (report_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS eme_generated_report_access_rep_idx  ON eme_generated_report_access (report_id)`,
  `CREATE INDEX IF NOT EXISTS eme_generated_report_access_user_idx ON eme_generated_report_access (user_id)`,
  `CREATE INDEX IF NOT EXISTS eme_generated_report_public_log_idx  ON eme_generated_report_public_log (report_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS eme_generated_report_custom_blocks_status_idx ON eme_generated_report_custom_blocks (status)`,
];

export async function ensureEmeReportsSchema() {
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
  console.log(`✅ [SchemaPatch] Relatórios da Eme schema garantido (${applied} OK, ${failed} skip).`);
}
