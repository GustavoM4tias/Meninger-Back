// lib/ensureProjectionLinkSchema.js
//
// Schema do vínculo CV ↔ Sienge das projeções e do corte por inatividade.
// Idempotente, roda todo boot.
//
// Contexto: a projeção do dashboard vem dos Grupos de Workflow (CV) e precisa
// casar com o empreendimento do Sienge. Esse casamento dependia só do
// `idempreendimento_int` do cadastro do CV; sem ele, o front adivinhava por
// semelhança de nome e errava calado. Agora existe vínculo explícito
// (enterprise_erp_links) e ele tem prioridade sobre qualquer heurística.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS enterprise_erp_links (
        id                  SERIAL PRIMARY KEY,
        cv_enterprise_id    INTEGER,
        cv_enterprise_name  VARCHAR(255),
        erp_enterprise_id   INTEGER      NOT NULL,
        erp_enterprise_name VARCHAR(255),
        description         VARCHAR(255),
        created_by          VARCHAR(120),
        active              BOOLEAN      NOT NULL DEFAULT true,
        created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
    )`,
    // Etapa (fase/módulo) do CV: permite que um empreendimento do CV aponte
    // para vários do Sienge, um por fase. Sem isso, "TERRAS DE SÃO PAULO V"
    // (um empreendimento no CV, com as fases como etapas) não tem como apontar
    // para "FASE 2" e "FASE 3" (dois empreendimentos no Sienge).
    `ALTER TABLE enterprise_erp_links ADD COLUMN IF NOT EXISTS cv_stage_name VARCHAR(255)`,

    // A unicidade é por ORIGEM COMPLETA (empreendimento + etapa): evita dois
    // destinos para a mesma origem, mas permite uma origem por fase.
    // Os índices antigos (sem etapa) são substituídos.
    `DROP INDEX IF EXISTS uniq_erp_link_cv_id`,
    `DROP INDEX IF EXISTS uniq_erp_link_cv_name`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_erp_link_cv_id_stage
        ON enterprise_erp_links (cv_enterprise_id, lower(COALESCE(cv_stage_name, '')))
        WHERE cv_enterprise_id IS NOT NULL AND active = true`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_erp_link_cv_name_stage
        ON enterprise_erp_links (lower(cv_enterprise_name), lower(COALESCE(cv_stage_name, '')))
        WHERE cv_enterprise_name IS NOT NULL AND active = true`,

    // Corte por inatividade, configurável por grupo de workflow.
    `ALTER TABLE cv_workflow_groups ADD COLUMN IF NOT EXISTS stale_days INTEGER DEFAULT 30`,

    /*
      menin_stage_num(texto) → número da fase/módulo, ou NULL.
      Os três sistemas escrevem a mesma fase de jeitos diferentes:
        CV        "MÓDULO 03", "FASE 01", "FASE III", "ETAPA 01"
        projeção  "... - MÓD 3"
        Sienge    "... - FASE 3 - COMERCIAL/INCORPORAÇÃO"
      Reduz todos a um inteiro para dar para casar. Aceita romano (I a VIII).
      Devolve NULL quando há mais de uma fase no texto ("FASE I e II") — nesse
      caso é ambíguo de verdade e a resposta certa é não adivinhar.
    */
    `CREATE OR REPLACE FUNCTION menin_stage_num(txt text) RETURNS int AS $$
     DECLARE
       s text;
       roman text;
     BEGIN
       IF txt IS NULL THEN RETURN NULL; END IF;
       s := upper(unaccent(btrim(txt)));
       -- Mais de uma fase citada: ambíguo, não resolve.
       IF s ~ '(^|[^A-Z0-9])(E|A|,|/|&)([^A-Z0-9]|$)' AND s ~ '[0-9IVX].*[^A-Z0-9].*[0-9IVX]' THEN
         RETURN NULL;
       END IF;
       -- Arábico: FASE 03, MODULO 3, ETAPA 01...
       IF s ~ '[0-9]' THEN
         IF (SELECT count(*) FROM regexp_matches(s, '[0-9]+', 'g')) > 1 THEN RETURN NULL; END IF;
         RETURN NULLIF(regexp_replace(s, '[^0-9]', '', 'g'), '')::int;
       END IF;
       -- Romano no fim do texto: FASE III, MOD IV...
       roman := substring(s from '(?:FASE|MODULO|MOD|ETAPA)\\.?\\s*(VIII|VII|VI|IV|V|III|II|I)\\s*$');
       IF roman IS NULL THEN RETURN NULL; END IF;
       RETURN CASE roman
         WHEN 'I' THEN 1 WHEN 'II' THEN 2 WHEN 'III' THEN 3 WHEN 'IV' THEN 4
         WHEN 'V' THEN 5 WHEN 'VI' THEN 6 WHEN 'VII' THEN 7 WHEN 'VIII' THEN 8
       END;
     END;
     $$ LANGUAGE plpgsql STABLE`,

    /*
      menin_base_name(texto) → nome sem o sufixo de fase e sem acento/pontuação.
      "TERRAS DE SÃO PAULO V - MÓD 3" → "TERRAS DE SAO PAULO V"
      Preserva o "V" do nome (que é parte do empreendimento) e tira só o sufixo
      que designa a fase.
    */
    `CREATE OR REPLACE FUNCTION menin_base_name(txt text) RETURNS text AS $$
       SELECT btrim(regexp_replace(
         regexp_replace(
           upper(unaccent(COALESCE(txt, ''))),
           '\\s*[-–]\\s*(FASE|MODULO|MOD|ETAPA)\\.?\\s*(VIII|VII|VI|IV|V|III|II|I|[0-9]+)\\s*$', ''
         ),
         '[^A-Z0-9]+', ' ', 'g'
       ))
     $$ LANGUAGE sql STABLE`,
];

export async function ensureProjectionLinkSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
        }
    }

    // Grupos criados antes desta coluna ficam com o default explícito, para não
    // dependerem do DEFAULT do DDL quando a linha já existia.
    try {
        await db.sequelize.query(
            `UPDATE cv_workflow_groups SET stale_days = 30 WHERE stale_days IS NULL`
        );
    } catch (err) {
        console.warn(`⚠️  [SchemaPatch] Backfill de stale_days falhou: ${err.message}`);
    }

    console.log(`✅ [SchemaPatch] Vínculo de projeção garantido (${applied} OK, ${failed} skip).`);
}
