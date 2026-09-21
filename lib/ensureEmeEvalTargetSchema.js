// lib/ensureEmeEvalTargetSchema.js
//
// A régua passa a saber O QUE avaliou.
//
// Antes, toda rodada rodava contra o prompt PUBLICADO. Enquanto a avaliação era
// opcional isso bastava; quando ela virou portão de publicação, deixou de
// bastar: travar a porta olhando para o que já está no ar não diz nada sobre o
// que vai entrar.
//
// `target` separa a rodada de diagnóstico ('ativo') da rodada que serve de
// prova ('rascunho'), e `target_hash` é a impressão do rascunho avaliado - sem
// ela dava para rodar a régua, continuar editando e publicar com o selo antigo.

import db from '../models/sequelize/index.js';

const STATEMENTS = [
    `ALTER TABLE eme_eval_runs ADD COLUMN IF NOT EXISTS target VARCHAR(20) NOT NULL DEFAULT 'ativo'`,
    `ALTER TABLE eme_eval_runs ADD COLUMN IF NOT EXISTS target_hash VARCHAR(64)`,
    // O portão busca sempre "a rodada mais recente de rascunho".
    `CREATE INDEX IF NOT EXISTS eme_eval_runs_target_idx
        ON eme_eval_runs (target, created_at DESC)`,

    // Ancoragem mínima esperada por caso: o critério que cobra a metade que
    // "chamou a tool certa" não cobre - quanto da resposta veio por referência.
    `ALTER TABLE eme_eval_cases ADD COLUMN IF NOT EXISTS min_ancoragem REAL`,
];

export async function ensureEmeEvalTargetSchema() {
    let applied = 0;
    let failed = 0;
    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); applied++; }
        catch (err) { failed++; console.warn(`⚠️  [SchemaPatch][EmeEvalTarget] ${err.message}`); }
    }
    console.log(`✅ [SchemaPatch] Alvo da régua da Eme garantido (${applied} OK, ${failed} skip).`);
}

export default ensureEmeEvalTargetSchema;
