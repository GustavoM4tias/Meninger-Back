// lib/ensureCvPanelSchema.js
//
// Garante a tabela cv_panel_settings (credencial do painel do CV para as APIs
// v3) e a tabela cv_imobiliaria_empreendimentos (espelho da associação
// imobiliária x empreendimento, que só a v3 sabe ler).
//
// As duas normalmente nascem do model no sync do boot; este patch é o "caso
// falhe" e, principalmente, o que SEMEIA a linha singleton da credencial a
// partir do .env — para quem já tinha configurado por variável de ambiente
// antes de a tela existir.
//
// A semeadura só preenche o que está VAZIO (`WHERE ... IS NULL`), nunca troca
// valor já gravado: o painel sempre ganha do código. Se um admin corrigir a
// senha pela tela depois de uma rotação do CV, um boot seguinte não pode
// devolver a senha velha do .env.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cv_panel_settings (
      id              SERIAL PRIMARY KEY,
      email           VARCHAR(255),
      senha           VARCHAR(255),
      painel          VARCHAR(40) DEFAULT 'gestor',
      notify_user_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
      last_ok_at      TIMESTAMP,
      last_error      TEXT,
      last_error_at   TIMESTAMP,
      alert_sent_at   TIMESTAMP,
      created_at      TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP   NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS cv_imobiliaria_empreendimentos (
      idempreendimento INTEGER   NOT NULL,
      idimobiliaria    INTEGER   NOT NULL,
      nome             VARCHAR(255),
      razao_social     VARCHAR(255),
      synced_at        TIMESTAMP,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (idempreendimento, idimobiliaria)
  )`,

  `CREATE INDEX IF NOT EXISTS cv_imob_emp_imobiliaria_idx
       ON cv_imobiliaria_empreendimentos (idimobiliaria)`,

  `CREATE TABLE IF NOT EXISTS cv_sync_jobs (
      key             VARCHAR(60)  PRIMARY KEY,
      active          BOOLEAN      NOT NULL DEFAULT false,
      cron_expression VARCHAR(120) NOT NULL,
      last_applied_at TIMESTAMP,
      created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
  )`,

  // Linha singleton: existe sempre, para a tela ter o que ler.
  `INSERT INTO cv_panel_settings (id, painel)
        VALUES (1, 'gestor')
   ON CONFLICT (id) DO NOTHING`,
];

export async function ensureCvPanelSchema() {
  let applied = 0, failed = 0;
  for (const sql of STATEMENTS) {
    try { await db.sequelize.query(sql); applied++; }
    catch (err) {
      failed++;
      console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
      console.warn(`    SQL: ${sql.slice(0, 100)}...`);
    }
  }

  // Semeia do .env SÓ o que estiver vazio (ver cabeçalho: a tela manda).
  const { CV_PANEL_EMAIL, CV_PANEL_SENHA, CV_PANEL_PAINEL } = process.env;
  if (CV_PANEL_EMAIL || CV_PANEL_SENHA) {
    try {
      await db.sequelize.query(`
        UPDATE cv_panel_settings
           SET email  = COALESCE(NULLIF(email, ''),  :email),
               senha  = COALESCE(NULLIF(senha, ''),  :senha),
               painel = COALESCE(NULLIF(painel, ''), :painel, 'gestor')
         WHERE id = 1
      `, {
        replacements: {
          email: CV_PANEL_EMAIL || null,
          senha: CV_PANEL_SENHA || null,
          painel: CV_PANEL_PAINEL || null,
        },
      });
    } catch (err) {
      console.warn(`⚠️  [SchemaPatch] Semeadura da credencial do CV falhou: ${err.message}`);
    }
  }

  console.log(`✅ [SchemaPatch] Credencial do CV (v3) garantida (${applied} OK, ${failed} skip).`);
}

export default ensureCvPanelSchema;
