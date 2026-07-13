// scripts/create_insights_daily.js
//
// Cria a tabela meta_insights_daily + índices de forma IDEMPOTENTE, via SQL
// direto — sem passar pelo sync({alter}) do boot (que trava). Rodar uma vez:
//   node scripts/create_insights_daily.js
//
// Seguro re-rodar (tudo IF NOT EXISTS).

import db from '../models/sequelize/index.js';

const SQL = `
CREATE TABLE IF NOT EXISTS meta_insights_daily (
  id            BIGSERIAL PRIMARY KEY,
  entity_level  VARCHAR(10) NOT NULL,
  entity_id     VARCHAR(40) NOT NULL,
  date          DATE NOT NULL,
  account_id    VARCHAR(40),
  campaign_id   VARCHAR(40),
  adset_id      VARCHAR(40),
  spend         DECIMAL(14,2) DEFAULT 0,
  impressions   INTEGER DEFAULT 0,
  clicks        INTEGER DEFAULT 0,
  reach         INTEGER DEFAULT 0,
  meta_leads    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS meta_insights_daily_lvl_entity_date
  ON meta_insights_daily (entity_level, entity_id, date);
CREATE INDEX IF NOT EXISTS meta_insights_daily_lvl_date
  ON meta_insights_daily (entity_level, date);
CREATE INDEX IF NOT EXISTS meta_insights_daily_campaign_date
  ON meta_insights_daily (campaign_id, date);
CREATE INDEX IF NOT EXISTS meta_insights_daily_account
  ON meta_insights_daily (account_id);
`;

try {
    await db.sequelize.query(SQL);
    const [rows] = await db.sequelize.query(
        `SELECT COUNT(*)::int AS n FROM meta_insights_daily`);
    console.log(`✅ meta_insights_daily pronta. Linhas atuais: ${rows[0].n}`);
    await db.sequelize.close();
    process.exit(0);
} catch (e) {
    console.error('❌ falha:', e.message);
    process.exit(1);
}
