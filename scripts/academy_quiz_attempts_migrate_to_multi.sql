-- ============================================================================
-- [OBSOLETO — não rodar manualmente]
-- ============================================================================
-- Esta lógica foi movida para lib/ensureAcademySchema.js, que roda
-- automaticamente no boot do server.js (padrão sync alter friendly,
-- conforme memory: feedback_sequelize_alter).
--
-- O arquivo é mantido apenas como referência histórica das queries.
-- Para aplicar no banco: basta subir o backend (boot faz tudo).
-- ============================================================================
-- S2.3: Permitir múltiplas tentativas de quiz por (user, track, item).
-- Antes: UNIQUE (user_id, track_slug, item_id) — forçava upsert.
-- Agora: UNIQUE (user_id, track_slug, item_id, attempt_number) — permite N.
-- ============================================================================

BEGIN;

-- 1) Adiciona coluna attempt_number se não existir (default 1 para registros antigos).
ALTER TABLE academy_user_quiz_attempts
    ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1;

-- 2) Adiciona coluna score_percent se não existir.
--    Para registros antigos, calcula 100 se allCorrect=true, senão 0.
ALTER TABLE academy_user_quiz_attempts
    ADD COLUMN IF NOT EXISTS score_percent INTEGER NOT NULL DEFAULT 0;

UPDATE academy_user_quiz_attempts
SET score_percent = CASE WHEN all_correct THEN 100 ELSE 0 END
WHERE score_percent = 0;

-- 3) Dropa a UNIQUE antiga (se existir) e cria a nova com attempt_number.
DO $$
BEGIN
    -- Remove constraint pelo nome antigo (pode variar — checa antes)
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'academy_user_quiz_attempts_user_id_track_slug_item_id'
    ) THEN
        DROP INDEX academy_user_quiz_attempts_user_id_track_slug_item_id;
    END IF;

    -- Variante de nome que o Sequelize pode ter criado
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'academy_user_quiz_attempts_user_id_track_slug_item_id_key'
    ) THEN
        DROP INDEX academy_user_quiz_attempts_user_id_track_slug_item_id_key;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'academy_user_quiz_attempts_user_track_item_attempt_unique'
    ) THEN
        CREATE UNIQUE INDEX academy_user_quiz_attempts_user_track_item_attempt_unique
            ON academy_user_quiz_attempts (user_id, track_slug, item_id, attempt_number);
    END IF;
END $$;

COMMIT;
