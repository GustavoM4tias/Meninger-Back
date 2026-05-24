-- scripts/sienge-grants.sql
--
-- Executado pelo SiengeBackupService após cada swap blue-green pra reaplicar
-- as permissões (GRANTs) — os roles em si são globais no Postgres e
-- sobrevivem ao DROP DATABASE, mas os GRANTs são por-database e precisam
-- ser reaplicados depois de cada restore.
--
-- IMPORTANTE: este arquivo NÃO contém senhas. CREATE ROLE com senha deve
-- ser feito UMA vez, manualmente (via psql ou DBeaver), no banco
-- `sie214801`. Depois disso, este arquivo cuida só dos GRANTs.
--
-- Como adicionar um novo usuário:
--   1. Criar o role uma vez no DBeaver/psql conectado em sie214801:
--        DO $$ BEGIN
--          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'novo_user') THEN
--            CREATE ROLE novo_user LOGIN PASSWORD 'senha_forte';
--          END IF;
--        END $$;
--   2. Adicionar os GRANTs abaixo neste arquivo.
--   3. Commit + push. O próximo backup reaplica automaticamente.

-- ─────────────────────────────────────────────────────────────────────────────
-- sienge_readonly  —  leitura total em public (BI, analista, dashboards)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT CONNECT ON DATABASE sie214801   TO sienge_readonly;
GRANT USAGE   ON SCHEMA   public      TO sienge_readonly;
GRANT SELECT  ON ALL TABLES    IN SCHEMA public TO sienge_readonly;
GRANT SELECT  ON ALL SEQUENCES IN SCHEMA public TO sienge_readonly;
