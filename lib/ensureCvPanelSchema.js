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
      last_ok_at      TIMESTAMPTZ,
      last_error      TEXT,
      last_error_at   TIMESTAMPTZ,
      alert_sent_at   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS cv_imobiliaria_empreendimentos (
      idempreendimento INTEGER   NOT NULL,
      idimobiliaria    INTEGER   NOT NULL,
      nome             VARCHAR(255),
      razao_social     VARCHAR(255),
      synced_at        TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (idempreendimento, idimobiliaria)
  )`,

  `CREATE INDEX IF NOT EXISTS cv_imob_emp_imobiliaria_idx
       ON cv_imobiliaria_empreendimentos (idimobiliaria)`,

  `CREATE TABLE IF NOT EXISTS cv_sync_jobs (
      key             VARCHAR(60)  PRIMARY KEY,
      active          BOOLEAN      NOT NULL DEFAULT false,
      cron_expression VARCHAR(120) NOT NULL,
      last_applied_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`,

  // Correção de 2026-08-24: a tabela nasceu com TIMESTAMP (sem fuso), fora do
  // padrão do resto do banco, que usa TIMESTAMPTZ. O efeito era visível: o
  // driver lê um "timestamp sem fuso" como se fosse hora LOCAL do processo,
  // então um horário gravado às 19:30 UTC voltava como 22:30 UTC e a tela
  // mostrava 19:30 onde deveria mostrar 16:30.
  //
  // O USING interpreta o que está gravado como UTC, que é como o Sequelize
  // escreveu. O IF do catálogo deixa a correção idempotente: rodar de novo numa
  // coluna já convertida deslocaria os valores outra vez.
  `DO $$
   DECLARE c text;
   BEGIN
     FOREACH c IN ARRAY ARRAY['last_ok_at','last_error_at','alert_sent_at','created_at','updated_at'] LOOP
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='cv_panel_settings'
            AND column_name=c AND data_type='timestamp without time zone'
       ) THEN
         EXECUTE format('ALTER TABLE cv_panel_settings ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''', c, c);
       END IF;
     END LOOP;
   END $$`,

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
