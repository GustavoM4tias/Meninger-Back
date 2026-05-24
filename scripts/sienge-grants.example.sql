-- scripts/sienge-grants.example.sql
--
-- Template do arquivo de GRANTs. O arquivo REAL é `sienge-grants.sql` (no
-- mesmo diretório), versionado normalmente — não contém senhas.
--
-- COMO FUNCIONA O FLUXO COMPLETO:
--   1. ROLES (com senha) → criados UMA vez via DBeaver/psql. Sobrevivem a
--      DROP DATABASE porque são GLOBAIS no Postgres.
--   2. GRANTs (sem senha) → reaplicados a cada backup pelo SiengeBackupService.
--      É o que vai no `sienge-grants.sql` versionado.
--
-- ─── PASSO 1 (manual, uma vez): criar role no banco sie214801 ───────────────
--
-- Conecte como admin (postgres) e rode:
--
--   DO $$
--   BEGIN
--     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sienge_readonly') THEN
--       CREATE ROLE sienge_readonly LOGIN PASSWORD 'SUA_SENHA_FORTE';
--     ELSE
--       ALTER ROLE sienge_readonly WITH LOGIN PASSWORD 'SUA_SENHA_FORTE';
--     END IF;
--   END $$;
--
-- Outros exemplos de roles:
--
--   -- App de produção (lê + grava em algumas tabelas, nunca DELETE)
--   CREATE ROLE sienge_app LOGIN PASSWORD 'CHANGE_ME';
--
--   -- Time financeiro (read-only de tabelas específicas)
--   CREATE ROLE sienge_financeiro LOGIN PASSWORD 'CHANGE_ME';
--
--
-- ─── PASSO 2 (versionado): GRANTs reaplicados a cada backup ─────────────────
--
-- Conteúdo abaixo é o que vai em `sienge-grants.sql`. Edite conforme os
-- usuários que quiser manter. O service aplica esse arquivo no banco
-- promovido (`sie214801`) após cada swap blue-green.

-- sienge_readonly  —  leitura total
GRANT CONNECT ON DATABASE sie214801   TO sienge_readonly;
GRANT USAGE   ON SCHEMA   public      TO sienge_readonly;
GRANT SELECT  ON ALL TABLES    IN SCHEMA public TO sienge_readonly;
GRANT SELECT  ON ALL SEQUENCES IN SCHEMA public TO sienge_readonly;

-- sienge_financeiro  —  só tabelas financeiras-chave
-- GRANT CONNECT ON DATABASE sie214801 TO sienge_financeiro;
-- GRANT USAGE   ON SCHEMA   public     TO sienge_financeiro;
-- GRANT SELECT ON
--     public.ecpgtitulo, public.ecpgparcela, public.ecpgbaixa,
--     public.ecrctitulo, public.ecrcparcela, public.ecrcbaixa,
--     public.ectblancamento, public.ectbconta,
--     public.ecadempresa,  public.ecadempreend, public.ecadcredor
-- TO sienge_financeiro;

-- sienge_app  —  leitura ampla, escrita restrita
-- GRANT CONNECT ON DATABASE sie214801 TO sienge_app;
-- GRANT USAGE   ON SCHEMA   public     TO sienge_app;
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO sienge_app;
-- GRANT INSERT, UPDATE ON public.evndcontrato, public.evndunidade TO sienge_app;
