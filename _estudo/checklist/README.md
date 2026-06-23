# Checklist - build log

Spec completa: [DESCRITIVO.md](./DESCRITIVO.md).

## Fase 0 - Fundação (FEITO)

Backend (schema + plumbing), verificado por smoke test (define + associate sem
banco vivo):

- **10 models** em `models/sequelize/checklist/`:
  `checklistTemplate`, `checklistTemplateSection`, `checklistTemplateItem`,
  `checklist`, `checklistSection`, `checklistStatus`, `checklistTask`,
  `checklistTaskAttachment`, `checklistTaskComment`, `checklistActivity`.
- Registro + associações em `models/sequelize/index.js`.
- **Seed idempotente** `services/checklist/seedChecklist.js`:
  catálogo GLOBAL de status (10, com state_class) + template
  "Lançamento de Empreendimento" (3 seções, ~80 itens) extraído 1:1 do Excel
  Três Marias - Ibitinga, com valores e prazos relativos aos marcos.
- Seed chamado no `server.js` (bootServer, após `seedInitialTypes`).
- Contexto de upload `CHECKLIST_ATTACHMENT` em `controllers/uploadController.js`.
- 6 tipos de notificação `checklist.task.*` em
  `services/notification/notificationTypes.js` (grupo "Checklist").

### Como as tabelas nascem
O `db.sequelize.sync({ alter: false })` do boot **cria** as tabelas novas
automaticamente (alter:false só evita ALTER em tabelas já existentes). Nenhum
índice é adicionado a tabela existente, então nao há risco do alter. No próximo
boot do backend: tabelas criadas + seed roda (idempotente).

### Pendente de verificação com banco vivo
Smoke test cobriu definição/associação. A criação real das tabelas e a execução
do seed acontecem no próximo boot do backend (requer credenciais de banco, fora
deste ambiente). Conferir nos logs: `[seedChecklist] status novos: N; template
"Lançamento de Empreendimento": criado (id X).`

## Fase 1 - Núcleo (FEITO)

Backend (verificado: smoke test importa rotas + 30 endpoints montam):
- Services `services/checklist/`: `lib.js` (progress/state_class, due_date por
  marco, activity, menções), `checklistService.js` (CRUD checklist/seções/status,
  dashboard, my-tasks), `templateService.js` (modelos + `instantiate` que calcula
  due_date pelos offsets/âncoras), `taskService.js` (tarefas/subtarefas,
  comentários c/ menção, anexos, cobrança, notificações assigned/completed/nudge/comment).
- `controllers/checklist/checklistController.js` + `routes/checklistRoutes.js`
  (30 rotas, `authenticate`+`requireInternal`, escrita de status = `requireAdmin`),
  montado em `server.js` como `/api/checklists`.

Frontend (verificado: `vite build` OK):
- `utils/Checklist/api.js` (cliente fetch), `stores/Checklist/checklistStore.js` (Pinia).
- `views/Office/Checklist/`: `Index.vue` (Painel + lista + Minhas Tarefas + modal
  criar-do-modelo), `Detail.vue` (cabeçalho c/ progresso/orçamento/marcos +
  switcher), `components/` ProgressRing, ChecklistTable (tipo planilha, status/prazo
  inline), ChecklistBoard (Kanban DnD por status), TaskDrawer (campos, anexos upload,
  comentários, atividade, cobrar, excluir).
- Rota `/checklists` + `/checklists/:id` em `office.routes.js`; categoria no
  `navRegistry.js` (OPERAÇÃO).

### Fast-follows da Fase 1 (FEITOS)
- **Seletor de usuários**: `GET /api/checklists/users` (`checklistService.listUsers`)
  + store `users`/`loadUsers`/`setAssignee` + select no TaskDrawer (com fallback de
  texto livre). Agora dá para vincular `assignee_user_id` real, e a cobrança/
  notificação dispara de verdade.
- **Importador de Excel**: `POST /api/checklists/import/excel`
  (`importService.importFromExcel`, lib `xlsx`): 1 aba = 1 seção, mapeia colunas
  TAREFA/CATEGORIA/STATUS/VALORES/DATAS/RESPONSÁVEL/ANOTAÇÕES, casa status pelo
  catálogo, parseia data BR (dd/mm/aaaa) e valor BR. Botão "Importar Excel" na Home.

### Limitações remanescentes
- Front validado em build (compile). Verificação visual/runtime exige o ambiente
  de dev (backend + banco + login).
- Import de Excel usa mapeamento fixo de colunas (sem tela de mapeamento) e nao
  importa marcos do topo (Meeting/Abertura) ainda.
- Permissões finas `checklist.*` ficam para a Fase 2 (hoje internal/admin).

## Fase 2 - Cobrança (régua configurável) (FEITO)

Verificado: smoke (39 rotas, motor carrega, helpers de fuso) + `vite build`.

- **Motor 100% configurável**: 2 models `checklist_settings` (enabled, run_hour,
  timezone, weekends, respect_user_prefs) e `checklist_reminder_rules` (a régua:
  por regra = offset/repetição/máx., apply_states, destinatários assignee/owner/
  users/roles, canais inapp/email/whatsapp, mensagem com placeholders, escopo
  GLOBAL/TEMPLATE/CHECKLIST).
- `services/checklist/cobrancaService.js`: settings/rules CRUD + `runEngine`
  (avalia regras × tarefas, dedupe diário por task:rule:date, render de
  placeholders, dispatch via NotificationService). Helpers de fuso sem plugin.
- `scheduler/checklistChaseScheduler.js`: tick horário; dispara na hora/fuso
  configurados (muda na hora, sem restart). Iniciado no `server.js`.
- Seed de régua default (5 degraus: D-3, D-1, D0, atraso a cada 2 dias, escalar
  ao dono em +5) - tudo editável depois.
- 7 rotas admin `/api/checklists/cobranca/*` (settings, rules CRUD, run com
  dryRun para simular).
- WhatsApp: specs `checklist_due_soon_v1`/`overdue_v1`/`nudge_v1` no catálogo
  (precisam ser aprovados na Meta para enviar de fato; in-app/e-mail já vão).
- Frontend: `stores/Checklist/cobrancaStore.js` + `views/Office/Checklist/
  Cobranca.vue` (parâmetros + editor da régua + Simular/Disparar agora) + rota
  `/checklists/cobranca` (admin) + item de nav.

### Fase 2.5 (FEITO)
- **WhatsApp provisionado na Meta**: `lib/ensureChecklistWhatsappTemplates.js`
  (no boot, não bloqueante) cria `checklist_due_soon_v1`/`overdue_v1`/`nudge_v1`
  (defs em `services/checklist/checklistWhatsappTemplates.js`). Enviados como
  PENDING; a Meta aprova depois. Só envia de fato quando APPROVED; requer
  WhatsApp config ativo (senão pula).
- **Dashboard rico**: endpoint `dashboard` agrega por status, por responsável
  (com % e atraso), em atraso e a vencer em 7 dias. Painel da Home reescrito com
  barra de distribuição + por responsável + listas de atraso/a vencer.
- **Timeline**: `components/ChecklistTimeline.vue` (Gantt leve, barras por
  contratação→entrega coloridas por status, marcos e linha "hoje), 3ª visão no
  Detail.

### Próximos
Importador do Planner (Graph) + aposentar Planner; Calendário; permissões finas
`checklist.*`; aprovar os templates WhatsApp na Meta. Verificação runtime pendente.

## Fase 3 - Autorização/Proofing
Models `checklist_proofs` + `checklist_proof_annotations` (já especificados no
DESCRITIVO) + canvas de marcação/desenho + versões + aprovar/solicitar ajuste.
