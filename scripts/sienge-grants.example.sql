-- scripts/sienge-grants.example.sql
--
-- Modelo de arquivo de GRANTs reaplicado pelo SiengeBackupService após cada
-- swap blue-green. Copie para `sienge-grants.sql` (mesmo diretório) e edite
-- conforme os usuários que quiser manter.
--
-- O arquivo real (`sienge-grants.sql`) é gitignored: senhas e mapeamentos de
-- acesso ficam fora do repo. O ".example.sql" é só template.
--
-- COMO O SERVICE EXECUTA:
--   1. Conecta no database recém-promovido (já com nome de produção).
--   2. Executa o conteúdo deste arquivo como UMA única query (separe statements
--      com `;` — o driver pg aceita múltiplos statements numa só `query()`).
--   3. Se algum statement falhar, o restore NÃO é revertido (banco já está
--      promovido). Erros aparecem no log do servidor pra você corrigir.
--
-- PONTOS IMPORTANTES:
--   - Roles são GLOBAIS no Postgres (não pertencem a um database). Criar role
--     em qualquer DB cria pra o servidor inteiro. `CREATE ROLE IF NOT EXISTS`
--     não existe — use o bloco DO $$ ... $$ abaixo pra idempotência.
--   - GRANTs em tabelas SÃO por database. Como o restore criou o DB do zero,
--     todo GRANT precisa ser reaplicado a cada execução. Esse arquivo serve
--     pra isso.
--   - Troque os 'CHANGE_ME' por senhas reais antes de usar.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ROLE: sienge_readonly  —  leitura total (analista, BI, relatórios)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sienge_readonly') THEN
    CREATE ROLE sienge_readonly LOGIN PASSWORD 'CHANGE_ME_readonly';
  END IF;
END $$;

GRANT CONNECT ON DATABASE sie214801 TO sienge_readonly;
GRANT USAGE   ON SCHEMA   public     TO sienge_readonly;
GRANT SELECT  ON ALL TABLES    IN SCHEMA public TO sienge_readonly;
GRANT SELECT  ON ALL SEQUENCES IN SCHEMA public TO sienge_readonly;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) ROLE: sienge_financeiro  —  leitura só de tabelas financeiras-chave
-- ─────────────────────────────────────────────────────────────────────────────
-- DO $$
-- BEGIN
--   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sienge_financeiro') THEN
--     CREATE ROLE sienge_financeiro LOGIN PASSWORD 'CHANGE_ME_fin';
--   END IF;
-- END $$;
--
-- GRANT CONNECT ON DATABASE sie214801 TO sienge_financeiro;
-- GRANT USAGE   ON SCHEMA   public     TO sienge_financeiro;
-- GRANT SELECT ON
--     public.ecpgtitulo, public.ecpgparcela, public.ecpgbaixa,
--     public.ecrctitulo, public.ecrcparcela, public.ecrcbaixa,
--     public.ectblancamento, public.ectbconta,
--     public.ecadempresa,  public.ecadempreend, public.ecadcredor
-- TO sienge_financeiro;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) ROLE: sienge_app  —  app de produção (leitura ampla, escrita restrita)
-- ─────────────────────────────────────────────────────────────────────────────
-- DO $$
-- BEGIN
--   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sienge_app') THEN
--     CREATE ROLE sienge_app LOGIN PASSWORD 'CHANGE_ME_app';
--   END IF;
-- END $$;
--
-- GRANT CONNECT ON DATABASE sie214801 TO sienge_app;
-- GRANT USAGE   ON SCHEMA   public     TO sienge_app;
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO sienge_app;
-- GRANT INSERT, UPDATE ON public.evndcontrato, public.evndunidade TO sienge_app;
-- -- DELETE é proposital ausente.
