// lib/ensureAcademySchema.js
//
// Patches defensivos para schema do Academy. Roda no boot, idempotente.
//
// Por que existe (memory: feedback_sequelize_alter):
// Este projeto usa sync({ alter: true }) — não roda migrations CLI.
// Quando adicionamos UNIQUE em colunas que JÁ TÊM dados duplicados, ou
// quando mudamos a estrutura de UNIQUE (ex: adicionar attempt_number na chave),
// o sync falha silenciosamente. Este arquivo:
//
//   1) Faz dedup de tabelas de progresso (antes do UNIQUE).
//   2) Adiciona colunas novas com defaults sensatos para registros antigos.
//   3) Dropa UNIQUE antiga incompatível antes do model recriar a nova.
//   4) Garante todos os UNIQUEs/índices que o model declara.
//
// Resultado: o backend pode subir limpo em qualquer ambiente — banco
// virgem, banco da Fase 0, ou banco já com S1 aplicado.

import db from '../models/sequelize/index.js';

// Statements críticos rodam ANTES do Sequelize sync (para evitar falhas
// silenciosas em sync alter ao tentar criar UNIQUE em cima de dups).
const PRE_SYNC_STATEMENTS = [
    // ─── COLUNAS NOVAS em tabelas que JÁ EXISTEM ──────────────────────────
    // CRÍTICO: precisa rodar ANTES do sync({alter:false}) global. O sync, mesmo
    // sem alterar colunas, tenta criar os ÍNDICES declarados nos models — e
    // CREATE INDEX numa coluna inexistente quebra o boot inteiro.
    // (memory: feedback_sequelize_alter — "cuidado com índices novos no model")

    // S2.1 — hierarquia de módulos
    `ALTER TABLE academy_track_items ADD COLUMN IF NOT EXISTS module_id INTEGER`,

    // S1.4 — trilhas obrigatórias com deadline
    `ALTER TABLE academy_track_assignments ADD COLUMN IF NOT EXISTS mandatory BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE academy_track_assignments ADD COLUMN IF NOT EXISTS due_at TIMESTAMP`,

    // S1.6 / S3.4 — evidência forense + analytics de abertura
    `ALTER TABLE academy_user_progress ADD COLUMN IF NOT EXISTS ip VARCHAR(64)`,
    `ALTER TABLE academy_user_progress ADD COLUMN IF NOT EXISTS user_agent TEXT`,
    `ALTER TABLE academy_user_progress ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP`,

    // E10 — contexto da sessão de chat (OFFICE | ACADEMY)
    `ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS context VARCHAR(20) NOT NULL DEFAULT 'OFFICE'`,

    // ─── Dedup tabelas de progresso (Fase 1) ──────────────────────────────
    // Mantém só a linha mais recente para cada chave lógica.
    `DELETE FROM academy_user_progress a
        USING academy_user_progress b
        WHERE a.id < b.id
          AND a.user_id = b.user_id
          AND a.track_slug = b.track_slug
          AND a.item_id = b.item_id`,

    `DELETE FROM academy_user_track_progress a
        USING academy_user_track_progress b
        WHERE a.id < b.id
          AND a.user_id = b.user_id
          AND a.track_slug = b.track_slug`,

    // ─── S2.3: prepara academy_user_quiz_attempts para múltiplas tentativas ────
    // O model antigo tinha UNIQUE (user_id, track_slug, item_id).
    // O novo tem (user_id, track_slug, item_id, attempt_number).
    // Precisamos: 1) adicionar attempt_number/score_percent  2) dropar UNIQUE antigo
    `ALTER TABLE academy_user_quiz_attempts
        ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE academy_user_quiz_attempts
        ADD COLUMN IF NOT EXISTS score_percent INTEGER NOT NULL DEFAULT 0`,

    // Backfill score_percent baseado em all_correct (registros antigos).
    `UPDATE academy_user_quiz_attempts
        SET score_percent = CASE WHEN all_correct THEN 100 ELSE 0 END
        WHERE score_percent = 0 AND all_correct IS NOT NULL`,

    // Dropa UNIQUE antigo (várias variações de nome).
    `DROP INDEX IF EXISTS academy_user_quiz_attempts_user_id_track_slug_item_id`,
    `DROP INDEX IF EXISTS academy_user_quiz_attempts_user_id_track_slug_item_id_key`,
    `ALTER TABLE academy_user_quiz_attempts
        DROP CONSTRAINT IF EXISTS academy_user_quiz_attempts_user_id_track_slug_item_id_key`,
];

// Statements pós-sync: garantem que UNIQUEs novos existam mesmo se o sync alter
// tiver pulado eles (acontece em alguns cenários do Sequelize com PostgreSQL).
const POST_SYNC_STATEMENTS = [
    // ─── Fase 1: UNIQUE em progress ─────────────────────────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_user_progress_user_track_item_unique
        ON academy_user_progress (user_id, track_slug, item_id)`,

    `CREATE UNIQUE INDEX IF NOT EXISTS academy_user_track_progress_user_track_unique
        ON academy_user_track_progress (user_id, track_slug)`,

    // ─── S2.3: UNIQUE novo do quiz attempt ────────────────────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_user_quiz_attempts_user_track_item_attempt_unique
        ON academy_user_quiz_attempts (user_id, track_slug, item_id, attempt_number)`,

    // ─── S1: UNIQUE em certificate code (idempotente) ─────────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_certificates_code_unique
        ON academy_certificates (code)`,

    // ─── S2.2: UNIQUE em quiz_question (link item↔pergunta) ────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_quiz_questions_item_question_unique
        ON academy_quiz_questions (item_id, question_id)`,

    // ─── S2.4: UNIQUE em article_versions ─────────────────────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_article_versions_article_version_unique
        ON academy_article_versions (article_id, version_number)`,

    // ─── 3.3: UNIQUE em post_upvotes ──────────────────────────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_post_upvotes_post_user_unique
        ON academy_post_upvotes (post_id, user_id)`,

    // ─── S3.3: UNIQUE em prerequisites (par track→required) ───────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_track_prerequisites_pair_unique
        ON academy_track_prerequisites (track_slug, required_track_slug)`,

    // ─── S4.4: UNIQUE em follows (follower → target) ──────────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_follows_follower_target_unique
        ON academy_follows (follower_id, target_type, target_ref)`,

    // ─── S4.2: UNIQUE em ratings (1 rating por user por target) ───────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_ratings_user_target_unique
        ON academy_ratings (user_id, target_type, target_ref)`,

    // ─── S5.1: UNIQUE em user_xp (1 row por user) ─────────────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_user_xp_user_id_unique
        ON academy_user_xp (user_id)`,

    // ─── S5.1: UNIQUE em xp_logs (anti-dup de XP) ─────────────────────────
    // Coalesce de NULLs porque INDEX UNIQUE em PG trata NULL como diferente.
    // Sem o COALESCE, refKind/refId NULL causaria múltiplos rows por (user, reason).
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_xp_logs_user_reason_ref_unique
        ON academy_xp_logs (user_id, reason, COALESCE(ref_kind, ''), COALESCE(ref_id, ''))`,

    // ─── S5.1: UNIQUE em user_badges (1 badge por user) ───────────────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_user_badges_user_badge_unique
        ON academy_user_badges (user_id, badge_slug)`,

    // ─── S5.2: UNIQUE em video_watches (1 row por (user, item)) ───────────
    `CREATE UNIQUE INDEX IF NOT EXISTS academy_video_watches_user_item_unique
        ON academy_video_watches (user_id, item_id)`,
];

async function runBatch(statements, label) {
    let applied = 0;
    let skipped = 0;
    for (const sql of statements) {
        try {
            await db.sequelize.query(sql);
            applied++;
        } catch (err) {
            // Em pre-sync algumas tabelas podem não existir ainda no primeiro boot.
            // Em pós-sync as tabelas já existem, então a falha é genuína.
            const msg = err?.message || '';
            const isTableMissing = /does not exist|relation .* does not exist/i.test(msg);
            if (isTableMissing) {
                skipped++;
            } else {
                console.warn(`⚠️  [AcademySchema] Falha (${label}): ${msg}`);
                console.warn(`    SQL: ${sql.slice(0, 120).replace(/\s+/g, ' ')}…`);
            }
        }
    }
    return { applied, skipped };
}

/**
 * Roda os patches que precisam acontecer ANTES do sync alter (dedup + drop UNIQUE).
 * Chamar imediatamente antes de `sequelize.sync({ alter: true })`.
 *
 * Em ambiente virgem (tabelas não existem), as queries falham com "relation does not exist"
 * e são silenciosamente puladas — o sync vai criar tudo do zero.
 */
export async function ensureAcademyPreSync() {
    const { applied, skipped } = await runBatch(PRE_SYNC_STATEMENTS, 'pre-sync');
    if (applied > 0) {
        console.log(`🔧 [AcademySchema] Pre-sync: ${applied} patch(es) aplicado(s), ${skipped} pulado(s).`);
    }
}

/**
 * Roda os patches que precisam acontecer DEPOIS do sync alter (índices novos).
 * Chamar imediatamente depois de `sequelize.sync({ alter: true })`.
 */
export async function ensureAcademyPostSync() {
    const { applied, skipped } = await runBatch(POST_SYNC_STATEMENTS, 'post-sync');
    console.log(`✅ [AcademySchema] Pos-sync: ${applied} índice(s) garantido(s), ${skipped} pulado(s).`);
}

/**
 * Wrapper que orquestra ambas as fases. Use no boot:
 *
 *   await ensureAcademyPreSync();
 *   await sequelize.sync({ alter: true });
 *   await ensureAcademyPostSync();
 *
 * Ou, se quiser tudo de uma vez (depois do sync — modo conservador):
 *
 *   await sequelize.sync({ alter: true });
 *   await ensureAcademySchema();
 *
 * Modo "tudo depois" é seguro porque o sync alter no caminho feliz já cria
 * as colunas; o pre-sync vira apenas backup defensivo.
 */
export async function ensureAcademySchema() {
    await ensureAcademyPreSync();
    await ensureAcademyPostSync();
}
