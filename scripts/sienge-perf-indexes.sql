-- Índices de performance do Office sobre o backup do Sienge (sie214801).
--
-- O restore diário recria o banco do zero, então estes índices precisam ser
-- reaplicados após cada swap (stage `applying_perf_indexes` do
-- SiengeBackupService). Todos usam IF NOT EXISTS e o prefixo idx_office_ para
-- não colidir com os índices nativos do dump do Sienge.
--
-- O banco é somente leitura para o Office (escrita só acontece no staging do
-- restore), então CREATE INDEX comum é seguro: bloqueia escrita, não leitura.
--
-- Cada statement roda isolado (best-effort): se um falhar, os demais aplicam.

-- Custos (regime de caixa): baixas filtradas por data de pagamento.
-- Parcial casando exatamente o predicado do listExpenseRows.
CREATE INDEX IF NOT EXISTS idx_office_ecpgbaixa_dtpagto
  ON ecpgbaixa (dtpagto)
  WHERE cdtipobaixa IN (1, 10) AND nuseqestorno IS NULL;

-- Centro de custo principal do título (DISTINCT ON ... ORDER BY peparticipacao DESC).
CREATE INDEX IF NOT EXISTS idx_office_ecpgapropfin_titulo
  ON ecpgapropfin (nutitulo, peparticipacao DESC NULLS LAST);

-- Departamento principal do título (DISTINCT ON ... ORDER BY peapropriado DESC).
CREATE INDEX IF NOT EXISTS idx_office_ecpgapropdepart_titulo
  ON ecpgapropdepart (nutitulo, peapropriado DESC NULLS LAST);

-- Somas/joins de parcelas por título (tt, links, status agregado da tela Títulos).
CREATE INDEX IF NOT EXISTS idx_office_ecpgparcela_titulo
  ON ecpgparcela (nutitulo);

-- Tela Títulos: filtro por período de emissão.
CREATE INDEX IF NOT EXISTS idx_office_ecpgtitulo_dtemissao
  ON ecpgtitulo (dtemissao);

-- Estatísticas atualizadas para o planner enxergar os índices novos.
ANALYZE ecpgbaixa;
ANALYZE ecpgapropfin;
ANALYZE ecpgapropdepart;
ANALYZE ecpgparcela;
ANALYZE ecpgtitulo;
