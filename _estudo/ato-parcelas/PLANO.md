# Ato: das cobrancas do ato para a gestao completa das parcelas (05/09/2026)

## O problema, medido na base (05/09/2026)

Hoje o Office cobra SO a entrada (serie 21 "Recurso Proprio a Vista" / 9 "Ato").
As mensais (serie 20 "Recurso Proprio Parcelado", 1 "PARCELAS MENSAIS", 37 "Parcelas
Mensais (URBAN)") so passam a ser cobradas quando o Financeiro FATURA o contrato no
Sienge, que gera os titulos (`contracts.receivable_bill_id` / `evndcontrato.nutitulo`).
Ate la ninguem cobra.

| recorte (ato pago, ultimos 12 meses)                                   | reservas | parcelas |
|------------------------------------------------------------------------|---------:|---------:|
| contrato no Sienge, NAO faturado, 1a mensal ainda nao venceu           |      227 |   12.458 |
| contrato no Sienge, NAO faturado, 1a mensal JA venceu (caixa parado)   |       30 |    1.732 |
| sem contrato no Sienge (envio falhou)                                  |        5 |      334 |
| ja faturado no Sienge (Sienge cobra - o Office NAO pode tocar)         |       86 |    4.251 |

Parcelas mensais JA VENCIDAS sem faturamento: **288 parcelas, R$ 344.897,86, em 245
reservas** (278 delas venceram nos ultimos 30 dias). Nos proximos 30 dias vencem mais 247.

## Regras de negocio (todas em settings + tela; codigo so como fallback)

1. **Plano de parcelas** nasce por reserva quando o ato e PAGO (boleto ou cartao).
   Parcelas derivadas de `condicoes.series[]` do CV: cada serie configurada gera
   `quantidade` parcelas mensais a partir do `vencimento` (dia preso ao fim do mes).
2. **Emissao antecipada**: o boleto da parcela sai N dias antes do vencimento
   (`parcelas_antecedencia_dias`, padrao 10), pelo mesmo Ecobranca, anexo no CV,
   e-mail + WhatsApp ao cliente, mensagem na reserva ("PARCELA n/N EMITIDA").
3. **Parada automatica**: contrato com `receivable_bill_id` no Sienge = faturado. O
   plano encerra (motivo `sienge_faturado`), parcelas previstas viram `transferida`.
   Reserva cancelada = plano cancelado + boletos em aberto baixados.
4. **Atraso**: boleto vencido e baixado pela rodada das 08h vira parcela `vencida`.
   O ciclo reemite (`atraso_reemitir`) com multa `atraso_multa_pct` (2%) + juros
   `atraso_juros_mes_pct` (1% a.m. pro rata), novo vencimento em `atraso_prazo_dias`
   (5), ate `atraso_max_reemissoes` (3) vias. Parcela que ja estava vencida quando o
   plano nasceu e emitida SEM encargos (nao foi culpa do cliente).
5. **Lembretes**: D-3 antes do vencimento e D+1 depois (e-mail sempre; WhatsApp
   quando o template estiver aprovado). Um envio por boleto.
6. **Interruptor mestre** `parcelas_ativo` nasce DESLIGADO: o deploy so calcula e
   mostra; nada e emitido ate ligar na tela.

## Arquitetura

- `boleto_history` continua sendo a tabela de boletos. Ganha `parcela_id` e `tipo`
  ('ato' | 'parcela'): verificacao de pagamento, baixa, PDF, timeline e reenvio
  funcionam sem mudar. O historico do Ato filtra `parcela_id IS NULL`, e os gates do
  webhook (ato pago, re-trigger) tambem - senao a parcela paga faria o webhook achar
  que o ATO foi pago.
- Novas tabelas `ato_planos` (1 por reserva) e `ato_parcelas` (1 por parcela).
- `lib/atoParcelas.js`: funcoes puras (derivar plano, encargos, decisoes). Testadas.
- `services/boleto/AtoParcelaService.js`: plano (criar, sincronizar com o CV,
  pausar, encerrar, encerramento automatico, listagem/KPIs).
- `services/boleto/ParcelaEmissaoService.js`: emite/reemite a parcela reaproveitando
  os primitivos do ato (validador de titular, nosso numero, lock, Playwright,
  Supabase, anexo no CV, mensagem no CV).
- `services/boleto/ParcelaNotifyService.js`: e-mail + WhatsApp da parcela, lembrete
  e aviso de atraso.
- `scheduler/atoParcelasScheduler.js`: 1 rodada por dia (`parcelas_hora_rodada`,
  padrao 09h Brasilia): adesao -> encerramento -> reemissao de vencidas -> emissao
  das que vencem em N dias -> lembretes. `runNow` pela tela.
- API em `/api/cobranca-ato/parcelas/*` com as capacidades da tela
  (`view`/`operate`/`configure`).
- Tela: aba **Parcelas** em Financeiro > Cobranca > Ato (KPIs, planos, detalhe com
  parcelas e acoes) + card **Parcelas mensais** nas Configuracoes.

## Testes

- `npm test` (node:test): derivacao do plano (dia 31, fevereiro, residuo, numeracao),
  encargos (multa + juros pro rata, arredondamento), decisao de emissao, parada.
- Dry-run na base real (`_tmp_parcelas_dryrun.mjs`): calcula os planos sem gravar.
- Depois do deploy: ligar `parcelas_ativo` para UM empreendimento de teste, rodar o
  ciclo pela tela, conferir boleto/e-mail/WhatsApp/mensagem no CV, depois abrir.
