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
