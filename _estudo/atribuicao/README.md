# Atribuição de Faturamento a Lead (Office x Meta x CV x Sienge)

Estudo de 17/08/2026. Objetivo: responder com número auditável "quanto do
faturamento veio dos leads que NÓS captamos", agora que a captação Meta é
interna (Central Meta) e não depende mais do RD Station.

Todos os números abaixo foram medidos no banco de produção (consultas somente
leitura, janela ago/2025 a jul/2026 salvo indicação).

---

## 1. A cadeia de ligação (o que já existe)

```
contracts (Sienge, faturamento)
   -> unidade principal (units[].id)
   -> repasses.codigointerno_unidade      [mesma lógica do contractSalesController]
   -> reservas.idreserva
   -> reservas.leads_associados[].idlead
   -> leads (espelho CV: midia_principal, origem, data_cad)
   -> inbound_leads.cv_idlead             [<- ELO QUE FALTA]
   -> meta_campaign_id / meta_ad_id / meta_form_id / utm_*
   -> meta_insights_daily (gasto por dia/campanha/anúncio)
```

Os quatro primeiros saltos já rodam em produção dentro do Faturamento
(`controllers/sienge/contractSalesController.js`, CTEs `rp_by_unit` /
`rp_fallback_per_contract` / `rp_final`). Nada precisa ser inventado ali: a
atribuição deve REUSAR essa resolução para nunca divergir do número oficial.

### Cobertura medida da cadeia (1.797 contratos com data da instituição financeira)

| Etapa | Contratos | % |
|---|---:|---:|
| Faturados no período | 1.797 | 100% |
| Casaram com uma reserva (via repasse) | 1.564 | 87,0% |
| Chegaram a um lead do CV | 1.524 | 84,8% |
| Lead do CV com `midia_principal` preenchida | 237 | 13,2% |
| Lead do CV com `origem` preenchida | 1.524 | 84,8% |
| **Chegaram a um lead do Office (`inbound_leads`)** | **5** | **0,3%** |

Ou seja: a cadeia é sólida até o CV e morre no último salto.

---

## 2. O que dá para responder HOJE (mídia do lead do CV)

Recorte dos 1.797 contratos por origem do primeiro lead da reserva:

| Bucket | Contratos | % | VGV (soma bruta) |
|---|---:|---:|---:|
| Originado dentro do CV (Painel Corretor/Gestor/Imobiliária) | 1.228 | 68,3% | R$ 289,7 mi |
| Sem lead identificado (contrato sem reserva casada) | 273 | 15,2% | R$ 28,3 mi |
| Outra mídia declarada (indicação, TV, rádio, painel, etc.) | 145 | 8,1% | R$ 33,7 mi |
| **Meta (Facebook/Instagram)** | **67** | **3,7%** | **R$ 16,7 mi** |
| Lead sem mídia declarada | 59 | 3,3% | R$ 13,4 mi |
| Busca (Google/Bing) | 25 | 1,4% | R$ 5,9 mi |

Detalhe por mês de faturamento (share Meta): oscila entre 1,2% e 8,1%, média
~3,6%. Ver consulta J do estudo.

Leitura honesta: pelo dado do CV, mídia paga Meta explica hoje algo em torno de
3 a 4% do faturamento. Esse número é PISO, não teto, porque:

- `midia_principal` só está preenchida em 13% dos leads que converteram. Lead
  cadastrado pelo corretor no painel (68% do faturamento) quase nunca carrega a
  mídia que trouxe a pessoa. Uma parte desses 68% é lead de campanha que o
  corretor recadastrou na mão.
- O VGV da tabela acima é soma bruta de `total_selling_value`, sem as regras de
  valor do Faturamento (terreno, `enterprise_value_rules`, ajustes contábeis).
  Serve para ordem de grandeza, não para relatório.

---

## 3. Por que o elo com o lead do Office ainda é zero

1. **Janela de dados.** `inbound_leads` só carimba `cv_idlead` a partir de
   jun/2026 (3.495 leads entregues + 99 de site_form). Antes disso quem
   entregava era o RD, sem carimbo.
2. **Ciclo de venda.** Mediana lead -> faturamento: 69 dias no Facebook Ads
   (p90 = 330 dias); 34 dias nas demais origens. A safra de jun/2026 só começa
   a aparecer no faturamento por volta de set/2026, com cauda de um ano.
3. **2.867 leads históricos parados.** O import histórico da Meta (fev a
   ago/2026) está com `status='historical'` e `cv_idlead` nulo. Medição: 93%
   deles (2.672) casam por telefone com algum lead já existente na tabela
   `leads`. Reconciliar puxa a atribuição própria de jun/2026 para fev/2026 -
   é a maior alavanca de curto prazo e não depende da API do CV (dá para casar
   contra o espelho local).

### Armadilha medida (importante)

Hoje existem 109 pares (lead do Office <-> reserva). Destes:

- apenas **17** têm a reserva POSTERIOR à captação do lead;
- **57** são reentrada (`is_reentry`): a pessoa já era cliente e preencheu o
  formulário de novo;
- a mediana da diferença reserva menos lead é **-251 dias** (a reserva veio
  ANTES do lead).

Um `JOIN` ingênuo entre lead e reserva infla o "faturamento vindo de lead" em
cerca de 6x. Regra obrigatória do modelo: só atribui se
`data_reserva >= dia do lead` e dentro da janela de atribuição.

---

## 3b. Regra adotada (decisão de 17/08/2026)

Lead **não cadastrado nos painéis internos** (Painel Corretor / Gestor /
Imobiliária) = lead nosso. É a mesma regra que a tela de Leads já usa
(`ORIGENS_EXCLUIDAS` no `leadsStore`, `origem_excluir` em `controllers/cv/leads.js`),
e vale mesmo quando o lead antigo não tem mídia nem campanha - o que veio da
Central Meta traz esses campos, o que veio antes não traz e nem por isso deixa
de ser captação nossa. Origem nula continua contando como nossa, igual lá.

Já implementado com essa regra (primeira entrega):

- `contractSalesController.js` devolve `lead_captacao` na visão de DETALHE
  (first touch entre os leads não-painel da reserva). O dashboard não paga o
  custo do bloco.
- Enriquecimento com campanha/anúncio da Central Meta só quando a captação é a
  que CRIOU o lead no CV (`inbound_leads.created_at <= leads.data_cad + 2 dias`).
  Sem esse corte, reentrada colava numa venda a campanha de uma captação
  POSTERIOR a ela. A guarda preserva 3.332 dos 3.594 vínculos entregues (93%).
- Selo "Lead" na listagem de clientes do `EnterpriseDetailModal` (compartilhado
  por Faturamento e Vendas x Projeção), com card no hover e link para
  `/marketing/leads?idlead=`.
- `GET /cv/leads?idlead=` ignora a janela de datas (o deep link chega de fora e
  o lead costuma ser bem anterior ao mês corrente).

Cobertura medida na entrega: 78 de 746 contratos faturados em 2026 (10,5%)
acendem o selo.

## 4. Estrutura proposta

### 4.1 Camada de dados: tabela `sales_attributions`

Grão = 1 linha por contrato faturado (`contract_id` PK). Mesmo grão do
Faturamento, então a soma sempre fecha com a tela oficial.

| Campo | Uso |
|---|---|
| `contract_id`, `enterprise_id`, `company_id`, `fi_date` | chave e recorte, copiados do pipeline do Faturamento |
| `idreserva`, `idrepasse` | rastro da resolução |
| `cv_idlead`, `lead_data_cad`, `lead_midia`, `lead_origem` | lead do CV |
| `inbound_lead_id`, `channel`, `meta_campaign_id`, `meta_adset_id`, `meta_ad_id`, `meta_form_id`, `utm_*` | lead do Office |
| `attribution_level` | `office_lead` \| `cv_media` \| `cv_origin` \| `unattributed` |
| `match_method` | `cv_idlead` \| `reconciliado_telefone` \| `reconciliado_email` \| `documento` |
| `confidence` | `high` \| `medium` \| `low` |
| `lead_at`, `reserva_at`, `lag_days` | ciclo e validação da janela |
| `is_reentry`, `excluded_reason` | auditoria do que foi descartado e por quê |

Regras:

- **First touch** por padrão: entre os leads associados à reserva, vale o de
  `data_cad` mais antiga que ainda esteja dentro da janela. Guardar também o
  last touch em coluna separada para comparar sem refazer o modelo.
- **Janela de atribuição**: 365 dias entre lead e reserva (configurável em
  `marketing_config`). Fora da janela -> `unattributed` com
  `excluded_reason='fora_da_janela'`.
- **Reentrada nunca atribui retroativo**: reserva anterior ao lead é descartada.
- **Distrato segue a regra de ouro do Faturamento**: venda com data da
  instituição financeira conta, distrato não subtrai. A atribuição herda a
  mesma regra, senão o share não bate com a tela de Faturamento.
- Rebuild **idempotente** por período (delete + insert da janela), rodado por
  scheduler diário depois do sync de contratos, mais botão "recalcular" na tela.
  Nada de script manual.

### 4.2 Serviço

`services/marketing/SalesAttributionService.js`

- `rebuild({ since, until })` - refaz a janela reusando a mesma CTE de
  contrato -> repasse -> reserva do `contractSalesController` (extrair essa CTE
  para um módulo compartilhado, para não haver duas verdades).
- `getFunnel({ since, until, groupBy })` - Investimento -> Leads -> Reservas ->
  Vendas -> VGV por campanha, anúncio, formulário, empreendimento ou canal.
- `getCoverage()` - saúde da atribuição (as métricas da seção 1), para a tela
  nunca vender um número sem mostrar a cobertura.

Segurança: rota de dados com `requireRoutePermission`, escopo por
`accessScopeService.visibleErpIds` (mesmo padrão do Faturamento), fail-closed.

### 4.3 Telas

1. **Central Meta -> nova aba "Resultado"** (`/meta?tab=resultado`): o funil
   completo com gasto do `meta_insights_daily` do lado dos leads, e reservas /
   vendas / VGV do lado do Sienge. KPIs: CAC, custo por reserva, custo por
   venda, ROAS, ciclo mediano. Drill: campanha -> anúncio -> lista de leads ->
   lista de contratos.
2. **Faturamento -> filtro e coluna "Origem do lead"**: sem tocar no VGV
   oficial, só um recorte a mais e um selo no modal de detalhe ("veio de lead
   do Office - campanha X"). Comportamento atual congelado.
3. **Aba de saúde** dentro do Resultado: % de contratos com reserva, com lead
   CV, com lead Office, leads sem `cv_idlead`. O número de atribuição nunca
   aparece sem a cobertura ao lado.

Mobile-first (diretoria acessa pelo celular): tabelas viram cards em 375px,
`PageHelp.vue` com "Como usar" explicando first touch, janela e por que o share
Meta é piso.

### 4.4 Fases

| Fase | Entrega | Efeito |
|---|---|---|
| F0 | Reconciliar os 2.867 históricos contra o espelho `leads` (telefone/e-mail/documento, com `confidence`), em lote e idempotente | Atribuição própria retroage de jun/26 para fev/26 |
| F1 | `sales_attributions` + serviço + endpoints + scheduler | Número existe e é auditável |
| F2 | Aba Resultado na Central Meta | Diretoria enxerga CAC/ROAS real |
| F3 | Coluna origem no Faturamento + export | Comercial usa no dia a dia |
| F4 | Tools da Eme (`DATA_TOOL_NAMES`) e relatório | Pergunta em linguagem natural |

---

## 5. Decisões que precisam do comercial antes do F1

1. First touch ou last touch quando a reserva tem vários leads associados.
2. Janela de atribuição (365 dias é o padrão sugerido, p90 do Facebook é 330).
3. Lead recadastrado pelo corretor no painel conta como marketing quando existe
   um `inbound_lead` da mesma pessoa anterior à reserva? (recomendo que sim,
   com `confidence='medium'` e coluna separada no relatório).
4. Distrato: confirmado que segue a regra do Faturamento (não subtrai).

---

## 6. Consultas de apuração usadas

Reproduzíveis com o espelho local; ver o corpo do estudo no histórico da
sessão. Resumo dos identificadores: `contracts`, `repasses`, `reservas`,
`leads`, `inbound_leads`, `meta_insights_daily`.
