# Checklist (Gestão de Lançamentos e Demandas)

> Spec de estruturação. Substitui o Microsoft Planner como fonte única de
> acompanhamento de tarefas/entregas da operação. Origem: o Excel
> `CHECKLIST-COMPLETO-IBITINGA.xlsx` (lançamento Três Marias - Ibitinga).

## 1. Problema e objetivo

Hoje a empresa acompanha dezenas de checklists diários (lançamentos de
empreendimento, operação, obra). O mais estruturado é o de lançamento, com
divisões padrão (Engenharia, Comercial, Agência de Marketing, Marketing
Interno), cada uma com tarefas, responsável, data de contratação, data
prevista, anotações, anexos e valores. O Planner atual nao dá:

- visão consolidada entre todos os checklists e responsáveis;
- cobrança automática de entregas com prazo;
- estrutura padronizada reaproveitável por empreendimento;
- anexos com etapa de autorização (comentar e desenhar sobre imagens).

Objetivo: um módulo nativo no Office para **criação, visualização, gestão,
cobrança e autorização**, reusando ao máximo a infraestrutura existente
(NotificationService, upload Supabase, permissões, padrão de modelagem).

### Decisões travadas (alinhamento inicial)
1. **Biblioteca de modelos**: um modelo "Lançamento de Empreendimento" pronto
   (semeado a partir deste Excel) + criar outros modelos reutilizáveis.
2. **Substituir o Planner**: nova ferramenta vira fonte única; importador do
   Planner (Graph API) migra o que existe e o item de menu do Planner é
   aposentado.
3. **Hierarquia**: Seção -> Categoria -> Tarefa -> Subtarefas.
4. **Cobrança nos 3 canais**: in-app + e-mail + WhatsApp (D-3/D-1/no dia/atraso
   + botão "cobrar agora"). WhatsApp exige template aprovado na Meta.

## 2. O que o Excel ensina (modelo de dados real)

- Arquivo = 1 checklist de 1 empreendimento. Datas-chave no topo:
  `MEETING: 18/06`, `ABERTURA DE LOJA: 27/06` (marcos do checklist).
- Cada aba = uma **Seção/Divisão**: `ENGENHARIA E COMERCIAL`, `AGÊNCIA - MKT`,
  `INTERNO - MKT`.
- Dentro da aba, coluna **CATEGORIA** agrupa tarefas (ex.: `EMPREENDIMENTO`,
  `MEETING`, `INAUGURAÇÃO`).
- Colunas por tarefa: `TAREFA`, `CATEGORIA`, `STATUS`, `PRIORIDADE`, `VALORES`,
  `DATA DE CONTRATAÇÃO`, `DATA PARA ENTREGA`, `RESPONSÁVEL`, `ANOTAÇÕES`.
- **Status é workflow rico e variável**, nao um done/não-done:
  SOLICITADO, EM ESTUDO, EM ORÇAMENTO, ORÇANDO, EM CRIAÇÃO, EM APROVAÇÃO,
  EM AJUSTE, EM EXECUÇÃO, EXECUTANDO, SOLIC P/ COMPRAS, CONCLUÍDO, etc.
  -> precisa ser **configurável** e normalizado por `state_class` para o
  cálculo de progresso/atraso funcionar em qualquer checklist.
- **Valores** somam por seção (ex.: ~R$118k no Interno) -> roll-up de orçamento.
- Responsáveis: TAKETA, DINIZ, CIDA, BRUNA, ADM -> vinculam a usuário quando
  possível; senão, rótulo livre (ex.: "ADM", "AGÊNCIA").
- Anotações com pistas de recorrência ("MENSAL") -> campo opcional de
  natureza do valor (avulso/mensal).

## 3. Arquitetura (reuso do que já existe)

| Necessidade            | Reusar                                                            |
|------------------------|------------------------------------------------------------------|
| Modelagem/registro     | `models/sequelize/<dominio>/*` + `index.js` + `Model.associate`   |
| Análogo de workflow    | `comercial/enterpriseCondition.js` (status, approval_history, idempreendimento, avulsa) |
| Notificações 3 canais  | `services/notification/NotificationService.js` + `notificationTypes.js` |
| Anexos                 | `controllers/uploadController.js` (Supabase, por `context`)       |
| Empreendimento         | `idempreendimento` -> `CvEnterprise` (nullable = avulso/genérico)  |
| Cobrança agendada      | `scheduler/*` (ex.: `eventReminderScheduler`, `conditionAutoGenerate`) |
| Importador Planner     | rotas `/api/microsoft/planner/*` (Graph) já existentes            |
| Permissões             | `userPermission` / `permissionProfile` (alçadas em /settings)     |
| Frontend               | Vue 3 + Pinia + Tailwind; libs já instaladas: `@panzoom/panzoom`, `html2canvas`, `jspdf`, `exceljs`, `echarts` |

Módulo novo, isolado: nao altera fluxo existente do Office (apenas adiciona nav
e, na Fase 2, aposenta o item do Planner).

## 4. Modelo de dados

Convenção do projeto: `tableName` snake_case, `underscored: true`,
`timestamps: true`. Pasta `models/sequelize/checklist/`.

### 4.1 Modelos (biblioteca de modelos reutilizáveis)
- **ChecklistTemplate** (`checklist_templates`): `name`, `description`,
  `kind` ('LAUNCH' | 'GENERIC' | livre), `icon`, `color`, `is_active`,
  `is_default`, `created_by`, `updated_by`.
- **ChecklistTemplateSection** (`checklist_template_sections`): `template_id`,
  `name`, `color`, `position`.
- **ChecklistTemplateItem** (`checklist_template_items`): `template_id`,
  `section_id`, `parent_item_id` (subitem), `title`, `category`,
  `default_priority`, `default_value`, `default_assignee_role`,
  `due_anchor` ('STORE_OPENING' | 'MEETING' | 'START'),
  `due_offset_days` (ex.: -7 = 7 dias antes do marco), `notes_template`,
  `position`.

### 4.2 Instância
- **Checklist** (`checklists`): `template_id` (nullable), `title`, `kind`,
  `idempreendimento` (nullable -> CvEnterprise), `display_name` (quando sem
  empreendimento), `status` ('active' | 'archived' | 'done'),
  `key_dates` (JSONB: `[{key,label,date}]` ex.: meeting/abertura),
  `owner_user_id`, `color`,
  `progress_cache` (JSONB: `{total,done,pct,overdue,budget}` recalculado em
  writes para o dashboard ficar barato), `created_by`, `updated_by`.
- **ChecklistSection** (`checklist_sections`): `checklist_id`, `name`,
  `color`, `position`.
- **ChecklistStatus** (`checklist_statuses`): catálogo configurável.
  `scope` ('GLOBAL' | 'TEMPLATE'), `template_id` (nullable), `label`,
  `color`, `state_class` ('TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' |
  'CANCELLED'), `position`, `is_active`. Resolve "cada checklist tem status
  diferente" sem quebrar progresso/atraso.
- **ChecklistTask** (`checklist_tasks`): `checklist_id`, `section_id`,
  `parent_task_id` (subtarefa), `category`, `title`, `description`,
  `status_id` (-> checklist_statuses), `priority`
  ('LOW'|'MEDIUM'|'HIGH'|'URGENT'), `value` (DECIMAL 15,2),
  `value_kind` ('ONE_TIME'|'MONTHLY'), `contracted_at` (DATEONLY),
  `due_date` (DATEONLY), `started_at`, `completed_at`,
  `assignee_user_id` (nullable -> User), `assignee_label` (texto livre),
  `position`, `created_by`, `updated_by`.
  Índices: `checklist_id`, `section_id`, `assignee_user_id`, `due_date`,
  `status_id` (adicionar com parcimônia, ver Seção 10).
- **ChecklistTaskAttachment** (`checklist_task_attachments`): `task_id`,
  `file_name`, `mime_type`, `url`, `storage_path`, `size`,
  `kind` ('FILE'|'IMAGE'), `uploaded_by`.
- **ChecklistTaskComment** (`checklist_task_comments`): `task_id`, `user_id`,
  `body` (suporta @menção, reusa `mentionable` do padrão Academy).
- **ChecklistActivity** (`checklist_activities`): `checklist_id`, `task_id`
  (nullable), `user_id`, `action`
  ('task.created'|'status_changed'|'assigned'|'due_changed'|'completed'|
  'comment.added'|'attachment.added'|'nudge.sent'...), `meta` (JSONB),
  `created_at`. Alimenta timeline/auditoria e dedupe da cobrança.

### 4.3 Autorização / Proofing (Fase 3 - modelado agora, construído depois)
- **ChecklistProof** (`checklist_proofs`): rodada de revisão sobre um anexo.
  `attachment_id`, `task_id`, `version_no` (1,2,3...),
  `supersedes_proof_id`, `status` ('OPEN'|'CHANGES_REQUESTED'|'APPROVED'),
  `requested_by`, `approver_user_id`, `decided_at`, `decided_by`,
  `decision_note`, `flattened_url` (render final com marcações "queimadas"
  via html2canvas/jspdf = a versão de autorização congelada).
- **ChecklistProofAnnotation** (`checklist_proof_annotations`): marcação/desenho.
  `proof_id`, `author_user_id`, `type`
  ('PIN'|'RECT'|'ARROW'|'FREEHAND'|'TEXT'|'HIGHLIGHT'),
  `geometry` (JSONB com coords **normalizadas 0..1** + `page` p/ PDF, para
  independer de zoom/resolução), `color`, `stroke_width`, `comment`,
  `resolved`, `resolved_by`, `resolved_at`.
  Render = overlay SVG sobre a imagem com `@panzoom/panzoom`. Nova versão =
  novo ChecklistProof com `version_no` incrementado.

### 4.4 Diagrama (texto)
```
ChecklistTemplate 1-* TemplateSection 1-* TemplateItem (self parent_item_id)
        |
        | instantiate()
        v
Checklist 1-* ChecklistSection 1-* ChecklistTask (self parent_task_id)
   |                                     |-- *  ChecklistTaskAttachment 1-* ChecklistProof 1-* ProofAnnotation
   |                                     |-- *  ChecklistTaskComment
   |                                     `-- status_id -> ChecklistStatus (GLOBAL|TEMPLATE)
   `-- * ChecklistActivity (timeline/auditoria)
```

## 5. Notificações (catálogo)

Adicionar em `notificationTypes.js` (grupo "Checklist"):

| type                          | quando                                   | canais default        |
|-------------------------------|------------------------------------------|-----------------------|
| `checklist.task.assigned`     | tarefa atribuída a você                  | in-app + e-mail       |
| `checklist.task.due_soon`     | D-3 / D-1 / no dia (scheduler)           | in-app + e-mail + wpp |
| `checklist.task.overdue`      | venceu e nao concluída (scheduler)       | in-app + e-mail + wpp |
| `checklist.task.nudge`        | cobrança manual ("cobrar agora")         | in-app + e-mail + wpp |
| `checklist.task.comment`      | comentário/menção na sua tarefa          | in-app                |
| `checklist.task.completed`    | tarefa concluída (avisa o owner)         | in-app                |
| `checklist.proof.requested`   | (F3) anexo enviado p/ sua autorização    | in-app + e-mail       |
| `checklist.proof.decided`     | (F3) aprovado / ajuste solicitado        | in-app + e-mail       |

WhatsApp (Meta) - criar e aprovar templates: `checklist_task_assigned_v1`,
`checklist_due_soon_v1`, `checklist_overdue_v1`, `checklist_nudge_v1`.
Variáveis: `userName`, `taskTitle`, `checklistTitle`, `dueDateFormatted`.

### Scheduler
`scheduler/checklistChaseScheduler.js` (node-cron diário, 08:00 America/Sao_Paulo):
para cada tarefa ativa com `due_date`, `state_class` nao em DONE/CANCELLED:
- `due_date` em hoje+3 / hoje+1 / hoje -> `due_soon`;
- `due_date` < hoje -> `overdue` (dedupe 1x/dia via ChecklistActivity;
  escala para o `owner_user_id` após N dias de atraso).
Destinatários: `assignee_user_id` (+ owner no atraso). Usa
`NotificationService.notify`.

## 6. API

`routes/checklistRoutes.js` -> `controllers/checklist/*` -> `services/checklist/*`.

Modelos:
- `GET/POST/PUT/DELETE /api/checklists/templates` (+ sections/items)
- `POST /api/checklists/templates/:id/instantiate` `{ idempreendimento,
  display_name, key_dates }` -> cria Checklist + seções + tarefas a partir do
  modelo, calculando `due_date` pelas âncoras/offsets.

Instâncias:
- `GET /api/checklists` (filtros: empreendimento, status, owner, overdue)
- `GET /api/checklists/:id` (full: seções, tarefas, status, progresso, orçamento)
- `POST/PUT /api/checklists/:id`, arquivar
- `GET /api/checklists/dashboard` (consolidado entre todos: atrasados, a vencer
  na semana, por responsável, por empreendimento, orçamento)
- `GET /api/checklists/my-tasks` (tarefas do usuário logado em todos)

Seções/Tarefas:
- `POST/PUT/DELETE /api/checklists/:id/sections` (+ reorder)
- `POST/PUT/DELETE .../tasks` (+ reorder, mover de seção, set status, atribuir,
  subtarefas via `parent_task_id`)
- `POST .../tasks/:taskId/nudge` (cobrança manual)
- Anexos: upload genérico (`context=checklist_attachment`) + vincular/remover
- Comentários: `GET/POST/DELETE .../tasks/:taskId/comments`
- `GET .../tasks/:taskId/activity`

Status (catálogo):
- `GET/POST/PUT/DELETE /api/checklists/statuses` (global + por template)

Importação:
- `POST /api/checklists/import/excel` (multipart xlsx): abas -> seções,
  linhas -> tarefas, mapeamento de colunas configurável. Usa lib `xlsx` (já no
  back). Pré-visualização antes de confirmar.
- `POST /api/checklists/import/planner` `{ planId }`: puxa via Graph
  (`getPlanFull` já existe) e materializa um checklist (migração do Planner).

Proofing (Fase 3):
- `POST .../attachments/:id/proofs`, `GET .../proofs`,
  `POST .../proofs/:id/annotations`, `PUT .../annotations/:id/resolve`,
  `POST .../proofs/:id/decide` (approve | changes), `POST .../proofs/:id/version`.

## 7. Frontend (Vue 3 + Pinia)

`src/views/Office/Checklist/`, `src/stores/Checklist/`.
Rotas em `office.routes.js`; item em `navRegistry.js` (substitui o do Planner).

- **ChecklistHome.vue**: grid de cards (empreendimento, anel de progresso,
  nº atrasados, orçamento, próximos marcos) + "Novo checklist" (escolhe modelo).
- **ChecklistDetail.vue**: cabeçalho (empreendimento, marcos, progresso,
  orçamento) + seletor de visões:
  - **Tabela** (tipo planilha, edição inline, agrupada por Seção -> Categoria,
    totais por seção): menor curva de adoção, espelha o Excel.
  - **Quadro/Kanban** (colunas por status; swimlanes por seção ou por
    responsável; arrastar muda status).
  - **Linha do tempo** (Gantt leve por `due_date`, marcos plotados).
  - **Por responsável** (agrupa por assignee; equivale a "minhas tarefas").
  - **Calendário** (entregas por dia).
- **TaskDrawer.vue**: detalhe completo (campos, subtarefas, anexos,
  comentários, atividade) + botão "Cobrar entrega" + "Solicitar demanda"
  (cria tarefa atribuída = intake rápido de demanda).
- **DashboardView.vue**: consolidado entre todos os checklists (a gestão
  "entre todos" que o Planner nao dá). ECharts/chart.js já instalados.
- **ImportWizard.vue**: importar Excel/Planner com preview e mapeamento.
- **admin**: TemplateManager.vue, StatusManager.vue.
- **(F3) ProofModal.vue**: viewer com `@panzoom/panzoom` + toolbar de marcação
  (pin/retângulo/seta/lápis/texto) + thread por marcação + seletor de versão +
  aprovar/solicitar ajuste. Sem libs novas (overlay SVG + html2canvas/jspdf
  para o flatten).

Sem novas dependências de front: Kanban com DnD nativo; Gantt com div/CSS ou
ECharts custom.

## 8. Permissões

Reusa `userPermission`/`permissionProfile` (alçadas em /settings/permissions):
- `checklist.view`, `checklist.create`, `checklist.manage` (editar qualquer),
  `checklist.admin` (modelos/status), `checklist.authorize` (Fase 3).
- Visibilidade por empreendimento/cidade alinhada ao padrão existente
  (`userCity`/`enterpriseCity`) - opcional restringir um checklist a quem vê o
  empreendimento.

## 9. Fases (rollout incremental)

- **Fase 0 - Fundação**: models + `associate` + registro no `index.js`
  (`sync alter` cuidadoso), seed do catálogo de status (com os status do Excel
  mapeados a `state_class`), contextos de upload, permissões, item de nav.
- **Fase 1 - Núcleo (substituto do Planner)**: CRUD checklist/seção/tarefa/
  subtarefa; biblioteca de modelos com "Lançamento de Empreendimento" semeado
  a partir DESTE Excel; instanciar por empreendimento; visões Tabela + Quadro +
  Por responsável; anexos; comentários; atividade; importador de Excel (migra
  os dezenas atuais); notifica ao atribuir/concluir. **Já mata a dor de
  visualização/gestão/criação.**
- **Fase 2 - Cobrança e inteligência**: scheduler D-3/D-1/dia/atraso; botão
  "cobrar agora"; WhatsApp (templates Meta); dashboard consolidado;
  Linha do tempo + Calendário; importador do Planner e aposentar o Planner.
- **Fase 3 - Autorização/Proofing**: proofs + versões + canvas de
  marcação/desenho + aprovar/solicitar ajuste + versão de autorização
  congelada + notificações de proof.

## 10. Notas de implementação

- **Schema via `sync({ alter: true })`** (nao migrations CLI). Adicionar
  índices com parcimônia; se o alter falhar por índice novo/duplicado, criar
  o índice à parte e validar em staging antes de produção.
- **Office congelado**: módulo novo nao muda regras/fluxos existentes. A única
  mudança em código compartilhado é o item de nav e (F2) aposentar o do Planner.
- **Sem em-dash** em textos/labels: usar hífen "-".
- **state_class** é o que mantém progresso/atraso corretos apesar de status
  livres por checklist.
- **progress_cache** evita recomputar agregados a cada abertura do dashboard;
  recalcular em writes de tarefa.
- O seed do modelo "Lançamento de Empreendimento" sai 1:1 deste Excel
  (3 seções, categorias e tarefas), então o primeiro checklist real nasce
  pronto.
