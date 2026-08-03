# Plano de Eventos - planejamento mensal de eventos comerciais

Data: 2026-08-03. Decisões fechadas com o Gustavo nesta data.

## O problema

Os gestores comerciais passam a ter, como regra nova do departamento, que propor
os eventos do mês seguinte: quais eventos, em que data, com quais itens e quanto
cada item custa. Hoje isso não existe em lugar nenhum do Office.

O que existia e por que não serve:

- **Eventos** (`events`): agenda de divulgação. Sem dinheiro, sem item, sem alçada.
  É o DESTINO do evento aprovado, não o container do planejamento.
- **Aprovações** (`marketing_approval_requests`): ficha unitária e tudo-ou-nada.
  Os perfis decidem em paralelo e qualquer reprovação encerra o ticket inteiro.
  Não tem mês, plano, prioridade, nem decisão por linha.
- **Checklist**: task-shaped. Sem valor por item nem soma de orçamento. Serve
  para EXECUTAR o evento, não para propor.

A diferença que define o módulo: aqui o aprovador não responde sim ou não, ele
**curadora**. Aprova o evento e corta um item. Aprova o item por um valor menor
que o proposto. Reprova dois dos cinco eventos. Nenhum módulo existente modela
decisão por linha com valor aprovado diferente do proposto.

## Decisões fechadas

1. **Tela**: uma rota nova só, `/comercial/plano-eventos`, dentro do Comercial.
   Três visões na mesma tela conforme o papel (gestor, validador comercial,
   aceite do marketing). NÃO é aba da Ficha Comercial: a alçada é por tela, e dar
   `/comercial/conditions` ao gestor abriria preço, comissão e subsídio; além
   disso a ficha aprovada trava e vai para assinatura, incompatível com uma lista
   que muda no meio do mês.
2. **Marketing não ganha tela**. O evento aceito vira registro em `events` e
   aparece na tela de Eventos que o marketing já usa. Verba formal continua em
   `/aprovacoes`.
3. **Fluxo**: gestor propõe -> validação Comercial -> aceite Marketing -> cria e
   programa o evento -> fechamento do mês congela tudo.
4. **Responsável pelo plano**: vem da Ficha Comercial
   (`enterprise_conditions.manager_user_id` + `enterprise_condition_modules.manager_user_id`).
   Não há cadastro paralelo.
5. **Ciclo**: abre na última semana do mês, submissão fecha depois da primeira
   semana do mês seguinte. Configurável nas settings.
6. **Item obrigatório reprovado**: a tela pergunta e força escolha explícita
   (reprovar o evento inteiro ou reclassificar o item como opcional).
7. **Primeiro ciclo real**: agosto/2026, aberto manualmente assim que a F1 subir.

## Fluxo e estados

```
[Gestor]     draft ──submete──▶
[Comercial]  pending_comercial ──aprova/ressalva──▶  (ou devolve ──▶ returned)
[Marketing]  pending_marketing ──aceita──▶ cria Evento em `events` e programa
[Mês]        approved ──fecha o mês──▶ closed (congelado, histórico)
```

`status` do plano: `draft` | `pending_comercial` | `pending_marketing` |
`returned` | `approved` | `closed`.

O status do plano é a POSIÇÃO NO FLUXO. A verdade sobre o que foi aprovado está
no status de cada evento e de cada item: um plano `approved` pode ter 3 eventos
aprovados e 2 reprovados.

**Atenção ao nome `closed`**: na Ficha Comercial `closed` significa
"empreendimento finalizado, não evolui mais". Aqui significa "mês encerrado e
congelado". Mesmo nome, sentido diferente. Não copie a regra do
`closeCondition` do `enterpriseConditionController`.

## Modelo de dados

### `event_plans` (plano mensal por empreendimento)
- `idempreendimento`, `reference_month` (DATEONLY, sempre dia 1)
- `owner_user_ids` JSONB: snapshot dos gestores resolvidos da ficha na abertura
- `owner_source`: `ficha` | `manual` (override do admin, registrado na trilha)
- `owner_unresolved` BOOLEAN: ficha sem gestor, ou gestor em `manager_mode: manual`
  (sem usuário do Office, não loga nem recebe notificação). Cai na lista de
  pendências do admin em vez de sumir calado.
- `status`, `round` (incrementa a cada devolução + reenvio)
- `submitted_at/by`, `comercial_decided_at/by`, `marketing_decided_at/by`,
  `closed_at/by`, `closing_note`
- `totals` JSONB (cache): `{ proposed, approved, events_proposed, events_approved }`
- UNIQUE (`idempreendimento`, `reference_month`)

### `planned_events` (evento proposto dentro do plano)
- `plan_id`, `title`, `kind`, `event_date`, `event_end_date` (nullable)
- `priority`: `ESSENCIAL` | `IMPORTANTE` | `DESEJAVEL`
- `objective` (para que serve), `expected_audience`
- `comercial_status` / `marketing_status`: `PENDING` | `APPROVED` |
  `APPROVED_WITH_NOTES` | `REJECTED` | `RETURNED`
- `is_extra` BOOLEAN: evento avulso incluído depois do plano aprovado. Corre o
  fluxo sozinho, sem reabrir os já aprovados.
- `event_id`: FK soft para `events`, preenchida no aceite do marketing
- `proposed_total`, `approved_total` (cache dos itens)

### `planned_event_items` (item do evento)
- `planned_event_id`, `name`, `category`, `quantity`, `unit_value`
- `proposed_value` (= quantity × unit_value), `approved_value` (nullable)
- `necessity`: `OBRIGATORIO` | `OPCIONAL`
- `cost_basis`: `ORCADO` (com fornecedor e anexo) | `ESTIMADO`
- `supplier`, `attachment_id` (F4)
- `comercial_status` / `marketing_status`: mesma lista do evento
- `needs_quote` BOOLEAN derivado: item `ESTIMADO` aprovado vira pendência de
  cotação para o marketing

### `event_plan_decisions` (a decisão, por escopo e etapa)
- `plan_id`, `scope`: `PLAN` | `EVENT` | `ITEM`, `scope_id`
- `stage`: `COMERCIAL` | `MARKETING`
- `profile_id`, `user_id`, `round`
- `decision`: `APPROVED` | `APPROVED_WITH_NOTES` | `REJECTED` | `RETURNED`
- `approved_value` (só em `ITEM`), `comment`
- Comentário OBRIGATÓRIO em `APPROVED_WITH_NOTES`, `REJECTED` e `RETURNED`.
- Decisões de rounds anteriores NUNCA são apagadas. Mesmo mecanismo do
  `ChecklistTaskApproval.round`.

### `event_plan_activities` (trilha completa)
- `plan_id`, `planned_event_id?`, `item_id?`, `user_id`, `action`, `meta` JSONB
- Molde exato do `checklistActivity.js`. Registra criação, edição de item,
  submissão, cada decisão, cada corte de valor, devolução e fechamento.

### `event_plan_auth_profiles` (alçada)
- `name`, `description`, `user_ids` JSONB, `is_active`
- Cópia do padrão `checklistAuthProfile.js`. Só admin gerencia.

### `event_plan_settings` (singleton)
- `stages` JSONB: `[{ order, key, name, profile_ids, min_amount? }]`
  Começa com COMERCIAL e MARKETING. Uma terceira etapa (diretoria acima de um
  teto) vira configuração, não código.
- `open_day_of_month` (padrão: última semana), `deadline_day_next_month` (padrão 7)
- `item_categories` JSONB
- `chase_enabled`, `run_hour`, `timezone`, `respect_user_prefs`

## Alçada

Três camadas, o padrão único do Office:

1. **Tela**: `requireRoutePermission(['/comercial/plano-eventos'])` em toda rota
   de dados. Admin bypassa.
2. **Dado**: `getScope` / `visibleCvIds` do `accessScopeService`. Fail-closed.
   O gestor só propõe para empreendimentos com grant. "Helena = Parque das
   Flores" NÃO é campo novo, é o grant dela.
3. **Papel no fluxo**: perfil habilita DECIDIR, grant define SOBRE QUAIS
   empreendimentos. Um aprovador nunca decide sobre plano que não enxerga.

Regras de escrita:
- Gestor edita só o próprio plano, e só em `draft` ou `returned`.
- Aprovador NUNCA edita. Falta item? Devolve com ressalva.
- Submetido trava para o gestor até devolução.

## Detalhes de uso que definem a qualidade da tela

- **Corte de valor**: item guarda proposto e aprovado. Comentário obrigatório. O
  gestor vê o corte E o motivo.
- **Item obrigatório reprovado**: modal pergunta se é para reprovar o evento
  inteiro ou reclassificar o item como opcional. Não bloqueia, força a escolha.
- **Contador ao vivo**: enquanto o aprovador marca, o topo mostra "aprovado até
  agora: R$ 11.200 de R$ 14.800". Lista ordenada por prioridade. É o que torna a
  tela usável no celular.
- **Reprovado não some**: fica no plano com motivo e autor, e entra no
  fechamento do mês como "proposto e não realizado, porque".
- **Devolver != reprovar**: devolver volta ao gestor com as marcações item a
  item; reprovar encerra aquele item ou evento naquele round.
- **Fila prioritária**: evento com data nos 10 primeiros dias do mês aparece no
  topo da tela do aprovador, porque a janela de aprovação vai até o dia 7 e ele
  pode acontecer antes de ser decidido. O gestor recebe o aviso ao cadastrar.
- **Evento extra**: incluído depois do plano aprovado, corre sozinho.

## Notificações (catálogo em `services/notification/notificationTypes.js`)

| Tipo | Quando | Para quem |
|---|---|---|
| `event_plan.opened` | Abertura do ciclo | Gestores responsáveis |
| `event_plan.chase` | Prazo chegando e plano ainda em draft | Gestores |
| `event_plan.submitted` | Gestor submete | Perfis da etapa Comercial |
| `event_plan.comercial_decided` | Comercial decide | Gestor + perfis do Marketing |
| `event_plan.marketing_decided` | Marketing aceita ou devolve | Gestor + Comercial |
| `event_plan.returned` | Devolução em qualquer etapa | Gestor |
| `event_plan.closed` | Mês fechado | Gestor + ambos os perfis |

## Fases

- **F1 (núcleo) — ENTREGUE em 2026-08-03**: 7 models, serviço de decisão, rotas
  com alçada, tela do gestor, tela do aprovador, tela de configuração, timeline,
  notificações do fluxo. Também entrou nesta leva o fechamento do mês, que era
  F2, porque congelar o mês é o que fecha o ciclo.
- **F2 (fluxo completo) — ENTREGUE em 2026-08-03**: `eventPlanAgendaService`
  publica em `events` todo evento aprovado nas duas etapas, no aceite do
  Marketing (idempotente, fora da transação da decisão); bloco "Itens previstos"
  na tela de Eventos (`PlannedItemsSection` — some sozinho quando o evento não
  veio de plano); consolidado do mês em aba (`GET /consolidated`) com agenda
  unificada e lista de compras agrupada por categoria; botão "Gerar ficha"
  criando o ticket em `/aprovacoes` (fala direto com a API de Aprovações, sem
  endpoint intermediário).
- **F3 (automação) — ENTREGUE em 2026-08-03**: `eventPlanCycleScheduler`, diário
  às 08:00, gated por `ENABLE_EVENT_PLAN_CYCLE`. Abre os planos do mês seguinte a
  partir da última semana e cobra o gestor nos offsets configurados (atrasado
  cobra todo dia). Advisory lock 884413, TZ configurável, catch-up no boot,
  dedupe da cobrança por dia via `event_plan_activities`. Elegível =
  empreendimento cuja ficha comercial mais recente não está `closed`.
- **F4 (acabamento) — ENTREGUE em 2026-08-03**: anexo de orçamento (contexto
  `event_plan_quote` no upload central; anexar liga `cost_basis=ORCADO`
  sozinho, e o link aparece no card para quem decide); PageHelp na tela; 3 tools
  da Eme (`query_event_plans`, `get_event_plan`, `get_event_plan_agenda`) no
  padrão `registerTool` do ToolRegistry com `requiredPermissions`, como manda o
  CLAUDE.md — nada no mapa legado do OfficeChatService.

## Resolução do responsável (F3, com stub em F1)

`services/eventPlan/eventPlanOwnerService.js`:

1. Acha a ficha mais recente do `idempreendimento` (qualquer status).
2. Junta `condition.manager_user_id` com os `manager_user_id` dos módulos onde
   `manager_mode = 'sistema'`.
3. Descarta nulos e duplicados. O resultado vira `owner_user_ids` do plano.
4. Nenhum resolvido, ou só gestores em `manager_mode: 'manual'` (sem usuário do
   Office) => `owner_unresolved = true` e o plano entra na lista de pendências
   do admin. Ninguém é cobrado no vazio.
5. O plano guarda SNAPSHOT: trocar o gestor na ficha depois não reescreve o
   histórico dos meses já abertos.
