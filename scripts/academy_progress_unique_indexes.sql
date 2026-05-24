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
-- Academy: garantir UNIQUE em tabelas de progresso (antes da Fase 1 sync).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) academy_user_progress (user_id, track_slug, item_id)
-- ---------------------------------------------------------------------------

-- Dedup: mantém apenas a linha mais recente (maior id) para cada chave.
DELETE FROM academy_user_progress a
USING academy_user_progress b
WHERE a.id < b.id
  AND a.user_id = b.user_id
  AND a.track_slug = b.track_slug
  AND a.item_id = b.item_id;

-- Cria UNIQUE se ainda não existir.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'academy_user_progress_user_track_item_unique'
    ) THEN
        CREATE UNIQUE INDEX academy_user_progress_user_track_item_unique
            ON academy_user_progress (user_id, track_slug, item_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) academy_user_track_progress (user_id, track_slug)
-- ---------------------------------------------------------------------------

DELETE FROM academy_user_track_progress a
USING academy_user_track_progress b
WHERE a.id < b.id
  AND a.user_id = b.user_id
  AND a.track_slug = b.track_slug;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'academy_user_track_progress_user_track_unique'
    ) THEN
        CREATE UNIQUE INDEX academy_user_track_progress_user_track_unique
            ON academy_user_track_progress (user_id, track_slug);
    END IF;
END $$;

COMMIT;
