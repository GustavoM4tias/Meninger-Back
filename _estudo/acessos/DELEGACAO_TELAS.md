# Delegação de telas - o que sai do admin-only e o que fica

Data da decisão: 2026-08-19 (Gustavo).

## A decisão

`adminOnly` no código passa a valer **só para a administração do próprio
sistema**. Cinco telas:

| Tela | Rota | Por que fica |
|---|---|---|
| Gestão do Academy | `/academy/admin` | administra conteúdo/estrutura do LMS |
| Empresas | `/settings/empresas` | pareamento CV × Sienge, base de todo o escopo |
| Departamentos | `/settings/management` | departamentos e cargos, base dos perfis |
| Integridade | `/settings/integrity` | validador de segurança do próprio sistema |
| Alçadas | `/settings/permissions` | quem define acesso não pode ser delegável |

**Todo o resto vira delegável por alçada**, com as funções sensíveis
limitadas DENTRO da tela (uma aba, um botão, um card) em vez de trancar a tela
inteira.

## A receita (padrão de CAPACIDADES, desde 2026-08-20)

Antes cada tela inventava a sua: um `computed(() => auth.hasRole('admin'))` no
componente escondia a aba e um `requireAdmin` solto guardava a rota. Duas
fontes de verdade, nenhuma auditável. Agora a regra é declarada UMA vez:

1. **Declare as ações** em `lib/screenCapabilities.js`:
   ```js
   '/mural/admin': { view: 'screen', manage: 'screen', remove: 'admin' },
   ```
   `'screen'` = basta ter a tela na alçada. `'admin'` = só administrador.
2. **API**: uma linha por ação, `requireCapability('/mural/admin', 'manage')`.
   Substitui o par requireRoutePermission + requireAdmin.
3. **Tela**: `const can = useCan('/mural/admin')` e `v-if="can('manage')"`.
   O front NÃO recalcula regra: o `/permissions/me` já devolve
   `capabilities: { '/rota': ['view','manage'] }` calculado no servidor, então
   a UI não tem como ficar mais permissiva que a API.
4. **navRegistry**: tira o `adminOnly` do item (vira switch nas Alçadas).
5. **office.routes.js**: tira `requiresAdmin`/`allowedRole` do meta.
6. **Dado de negócio** passa pelo `accessScopeService` (REGRA DE OURO).
7. **Tool da Eme** equivalente: mesma alçada e MESMO recorte da tela.

O validador (`/settings/integrity`) cobra: ação declarada e não exigida por
nenhuma rota acende warn — é o caso clássico de esconder o botão e deixar a API
aberta.

> Regra que não se negocia: **liberar a tela sem trocar o gate da API não dá
> acesso nenhum** - o usuário abre a tela e leva 403 em tudo. Os dois lados
> mudam juntos, sempre.

---

## Feito

### Boleto Caixa - `/financeiro/boleto-caixa` (2026-08-19)

| Função | Quem | Como |
|---|---|---|
| Histórico, filtros, facetas, KPIs | alçada | `requireRoutePermission` + escopo por empreendimento |
| Detalhe, timeline, eventos, contato do titular | alçada | idem + `requireHistoryInScope` (item fora do escopo = 404) |
| Reprocessar / reemitir / regerar | alçada | idem |
| Marcar como baixado / verificar pagamento | alçada | idem |
| Reenviar boleto ao cliente | alçada | idem |
| **Aba Configurações** (credenciais Ecobrança, webhook, janelas, situações CV) | **admin** | `requireAdmin` mantido |
| **Regras de comissão por empreendimento** | **admin** | `requireAdmin` mantido |
| **Template de WhatsApp** (criar/sincronizar na Meta) | **admin** | `requireAdmin` mantido |
| **Simular webhook** | **admin** | `requireAdmin` mantido |
| Tool `query_boletos` da Eme | **admin** | segue `adminOnly` - abrir depois exige levar o escopo de empreendimento para dentro do handler |

Escopo de dados: `boleto_history.empreendimento` é TEXTO (nome vindo do CV), não
id. O recorte casa esse texto com o NOME dos empreendimentos liberados
(`services/boleto/boletoScope.js`). Hoje 955 das 967 linhas casam; as 12 restantes
(9 com empreendimento nulo + 3 de "PARQUE ALAMEDA - VOTUPORANGA", que não existe
no registro unificado) ficam visíveis só para admin. **Sem grant = nenhuma
linha**, igual às demais telas.

---

### Cancelamento de Reservas - `/comercial/cancelamento-reservas` (2026-08-19)

Liberado para o **Comercial** (entrou na matriz do Padrão - Comercial).

| Função | Quem | Como |
|---|---|---|
| Histórico, filtros, facetas, KPIs, detalhe e timeline | alçada | `requireRoutePermission` + escopo por `idempreendimento_cv` |
| Reprocessar um caso do histórico | alçada | idem + `requireCancelInScope` (item fora do escopo = 404) |
| **Aba Configurações** (ativação da automação, regras do webhook do CV) | **admin** | `requireAdmin` mantido |
| **Processar reserva manualmente** (qualquer idreserva) | **admin** | não parte de um caso do histórico, então não tem escopo onde se ancorar |
| **Simular webhook** | **admin** | `requireAdmin` mantido |

Escopo mais simples que o do Boleto Caixa: `reserva_cancel_history` guarda
`idempreendimento_cv`, então o recorte é o `visibleCvIds` de sempre — sem casar
nome por texto. 93 das 94 linhas casam com o registro unificado; a que está sem
id fica visível só para admin.

A tela não estava preparada para não-admin (as abas eram um array fixo e o
`onMounted` sempre buscava as configurações): virou `computed` por `isAdmin`,
igual ao Boleto Caixa.

---

### Atualizações - `/docs` (2026-08-20)

Changelog do sistema, sem API própria. Virou **livre para todos os logados**:
não há nada a limitar num changelog. Saiu o `adminOnly` do item e o
`requiresAdmin` da rota — a categoria "Sobre o Office" já é
`permissionManaged: false`, então a tela nasce livre sem precisar de switch.
Fecha de vez a contradição que existia (registry dizia admin, a rota não exigia).

---

### Gestão do Mural - `/mural/admin` (2026-08-20)

Primeira tela nascida no padrão de capacidades.

| Ação | Regra | O que cobre |
|---|---|---|
| `view` | alçada | listar comunicados, abrir um, ver aderência |
| `manage` | alçada | criar, editar, público-alvo, publicar, arquivar, reativar |
| `remove` | **admin** | excluir de vez (some com a trilha de leitura) |

O mural do usuário (`/mural`) continua `permissionManaged: false` — o gate lá é
a audiência do comunicado, não a alçada.

**Ninguém tem a tela ainda**: ela não entrou em perfil nenhum de propósito.
Ligue o switch em Alçadas para quem faz comunicação interna.

---

## Fila (a fazer aos poucos, uma por vez)

Ordem sugerida: da mais parecida com o Boleto Caixa (menos risco) para a mais
delicada.

### 1. Sobre o Office - `/sobre` e `/sobre/relatorio`
- alçada: mapa do sistema e visão executiva (leitura).
- admin: nada, MAS `/api/about/metrics` devolve números da empresa inteira -
  decidir se o leitor vê o consolidado ou só o escopo dele.
- Atenção: a categoria é `permissionManaged: false`; para virar delegável tem
  que sair dela ou a categoria deixa de ser livre.

### 2. Central Meta - `/meta`
Abas: Captação, Campanhas, Vínculos CV, Formulários, Credenciais, Configurações.
- alçada: Captação, Campanhas, Vínculos CV, Formulários (operação de marketing).
- **admin**: Credenciais (App Secret/token da Meta) e Configurações.
- API: `/api/marketing` inteiro é `router.use(authenticate, requireAdmin)` -
  precisa ser quebrado por grupo de endpoint, é o maior trabalho da fila.

### 3. WhatsApp - `/settings/whatsapp`
Abas: Configuração, Templates, Automações, Gastos, Mensagens.
- alçada: Mensagens e Gastos (acompanhamento).
- **admin**: Configuração (token/credenciais), Templates e Automações.

### 4. Cérebro da Eme - `/tools/eme-brain`
Abas: Identidade, Políticas, Glossário, Comportamento, Relatórios, Insights,
Validação, Versões.
- alçada: Insights e Validação (leitura do que a Eme respondeu).
- **admin**: tudo que edita e publica regra (Identidade, Políticas, Glossário,
  Comportamento, Versões) - é o que muda o comportamento da IA para todos.

### 5. Eme Atende - `/tools/eme-atende`
- alçada: conversas e leads atendidos.
- **admin**: gate `eme_atende_settings.active`, fluxos e configuração da IA.

### 6. Backup Sienge - `/settings/backup-sienge` e DocuSign - `/settings/docusign`
- alçada: status/última execução (leitura).
- **admin**: credenciais, disparo manual, reconexão OAuth.

### 7. Usuários - `/settings/users` (a mais delicada, deixar por último)
- alçada: consultar usuários, ver situação de cadastro.
- **admin**: criar/ativar/inativar, aprovar 1º acesso, senha provisória, trocar
  role e vincular perfil de alçada. Delegar qualquer uma dessas = delegar
  concessão de acesso, o que na prática contorna a tela de Alçadas.

---

## Telas migradas para capacidades (2026-08-20)

| Tela | Ações | Observação |
|---|---|---|
| `/financeiro/boleto-caixa` | view, operate, configure | |
| `/comercial/cancelamento-reservas` | view, operate, configure | |
| `/mural/admin` | view, manage, remove | |
| `/checklists` | view, manage | `view` cobre participar da PRÓPRIA tarefa; a propriedade segue no `taskService` |
| `/comercial/conditions` | view, configure | editar/autorizar ficha continua sendo regra de NEGÓCIO (`GET /conditions/permissions`) |
| `/financeiro/paymentflow` | view, configure | `configure` = tipos de lançamento + coluna de autoria |
| `/settings/organograma` | view, edit | `edit` = "Editar layout" |
| `/comercial/relatorios/faturamento` | view, configure | `configure` = regras de valor/comissão, ajuste contábil, fechamento mensal |
| `/comercial/relatorios/projecao` | view, configure | `configure` = modo de meta global + exceções |
| `/comercial/buildings` | view, sync | `sync` = puxar tabelas de preço do CV |
| `/comercial/mcmv` | view, configure | `configure` = limites por cidade |
| `/comercial/projections` | view, edit | `edit` = criar/clonar/salvar/excluir projeção |
| `/marketing/viabilidade` | view, configure | `configure` = liberação por etapa, tetos |
| `/marketing/leads` | view, audit | `audit` = trilha de exportações |

Nos quatro últimos o gate de admin era um `if` dentro do controller; virou linha
declarada na rota. Nenhum acesso mudou: o mapeamento é 1:1 com o que já valia.

`/settings/management` ficou de fora de propósito: é 100% administração do
sistema, não tem ação delegável. Só trocou a fonte do `if` de guarda
(`authStore.hasRole` → permissões confirmadas pelo servidor).

### Onde a capacidade NÃO se aplica

Capacidade responde "alçada x admin". Regra de NEGÓCIO fica no módulo:
- quem pode autorizar uma ficha comercial (perfil de autorização);
- quem é dono/responsável de uma tarefa de checklist;
- qual comunicado cada pessoa recebe (audiência do mural).

Misturar as duas coisas na tabela transformaria `screenCapabilities.js` num
segundo motor de regras — e o ponto dele é ser lido de bate-pronto.

## Admin lido do `localStorage`: fechado em 2026-08-20

Seis arquivos decidiam permissão com
`localStorage.getItem('role') === 'admin'` — qualquer pessoa se promovia a
admin no devtools e destravava os controles. Todos migrados para capacidades:

| Arquivo | Tela | Ação |
|---|---|---|
| `Faturamento/components/EnterprisesSalesTable.vue` | relatório de Faturamento | `configure` (regras + consolidação) |
| `Faturamento/components/ClosingModal.vue` | idem | `configure` |
| `Faturamento/components/EnterpriseDetailModal.vue` | idem | `configure` (ajuste contábil) |
| `Sales-Projection/components/EnterpriseComparisonTable.vue` | relatório Vendas x Projeção | `configure` |
| `Sales-Projection/components/ProjectionSettingsModal.vue` | idem | `configure` (modo de meta) |
| `Faturamento/Index.vue` | — | computed morto, removido |

`authStore` ainda grava `localStorage.role` no login, mas **nada lê**: ficou
marcado como legado no código para ninguém voltar a usar.

Nenhum uso mudou: o app sempre gravou ali o papel REAL vindo do servidor, então
admin continua vendo o que via e não-admin idem. O que deixou de funcionar foi
só a edição manual do navegador.

### Correção sobre o goal-mode

Eu havia reportado que `PUT /api/projections/goal-mode` não exigia admin. Isso
estava **errado**: o guard existe (`assertAdmin` dentro do controller, como em
outros 7 endpoints de projeção). Não havia porta aberta. O que se fez foi
hoistar a regra para a rota (`requireCapability('/comercial/relatorios/projecao',
'configure')`), para o validador enxergar e a tela ler a MESMA linha. O
`assertAdmin` do controller continua como segunda tranca.

O mesmo tratamento foi dado ao fechamento mensal (`salesClosingRoutes`), que
tinha `requireAdmin` solto nas três mutações.

## Varredura concluída: nenhum `role === 'admin'` decide permissão (2026-08-20)

As 23 ocorrências restantes foram tratadas. Três destinos, por natureza da tela:

**1. Tela delegável com ação de admin dentro → capacidade** (5 telas novas,
listadas na tabela acima). Nos cinco casos o gate de admin já existia no
backend, mas escondido: `assertAdmin` dentro do controller (Projeção, 7
endpoints) ou `requireAdmin` solto na rota (Viabilidade, MCMV, tabelas de preço,
trilha de exportações). Todos hoistados para `requireCapability`.

**2. Tela 100% admin por código, ou livre com um detalhe de admin → fonte
autoritativa** (`permissionStore.isAdmin`, confirmado pelo servidor, em vez do
`authStore`): Nav, Usuários (tela + modal), Campanhas e Captação (painéis da
Central Meta), Alertas, Conta/ProfileSection, Suporte. Não cabe capacidade
nessas: ou a tela inteira é admin, ou é livre para todos e o admin só vê um
extra.

**3. Falso positivo → nada a fazer**: `Settings/Permissions/Index.vue` (o
`user.role === 'admin'` é o papel do usuário DA LISTA, não do logado),
`Marketing/Settings` (rótulo "(admin)" ao lado do nome), `EmeBrain` (papel
SIMULADO no sandbox da Eme).

Removidos de quebra: dois `computed` de admin declarados e nunca usados
(`Faturamento/Index.vue`, `Custos/Index.vue`).

Estado final: **14 telas** com capacidade declarada, **31 ações**, e a simulação
do check do validador não encontra nenhuma ação declarada sem enforcement.

### Onde o admin ainda é lido direto (e por que está certo)

`permissionStore.isAdmin` continua sendo consultado em tela admin-only e no
menu. Isso é o padrão, não dívida: capacidade descreve DELEGAÇÃO, e uma tela que
nunca vai ser delegada não ganha nada em declarar ação. A regra prática está no
CLAUDE.md do Back.

## Pontos soltos herdados (fora do adminOnly)

| Item | Situação | Decisão |
|---|---|---|
| Módulo Aprovações (`/aprovacoes`) | tela delegável com API sem alçada | **REMOVIDO 100% em 2026-08-19** (tela, rotas, store, API, models, services, PDF, WhatsApp, notificações, 6 tabelas e o "Gerar ficha de aprovação" do Plano de Eventos). Os templates `approval_request_v1` e `approval_decided_v1` continuam aprovados na Meta e aparecem como ÓRFÃOS em /settings/whatsapp > Templates: excluir por lá |
| `/financeiro/paymentflow` | tela inativa | mantida registrada e delegável, mas **sem alçada para ninguém**: fora da matriz do seed e retirada de todos os perfis/exceções (`ensurePermissionRouteRetirement`) |
| `/settings/organograma` | era livre para qualquer autenticado | virou **alçada**: `requireRoutePermission` no GET, e só o perfil **Padrão - Comercial** tem a rota. A tool `query_people` da Eme acompanha (mesma alçada) |
| `/api/microsoft` | telas delegáveis, API só autenticada | aceito: cada handler usa o token DELEGADO do próprio usuário; declarado com motivo no validador |
| `/microsoft/inperson/recording` | tela real, sem entrada no navRegistry | **RESOLVIDO**: a rota declara `meta.permissionRoute: '/microsoft/teams'` e herda a alçada da Central Microsoft. O guard e a auditoria de rotas honram o campo — é o padrão para sub-tela sem item de menu próprio |
| 15 usuários sem perfil | rodam só com o pacote legado do cutover, e são exatamente os mesmos 15 sem empreendimento liberado | lista com sugestão de perfil em `USUARIOS_SEM_PERFIL.md` |
| Notificações | as preferências ofereciam TODOS os tipos do catálogo | **RESOLVIDO**: `/settings/notifications` (e a tool da Eme) só listam o que a alçada do usuário sustenta (`SCREENS_BY_TYPE` em notificationTypes.js). A ENTREGA continua por destinatário — quem é responsável por uma tarefa recebe o aviso tendo a tela ou não |
| Perfil padrão por cidade | descartado | no lugar dele: **conjuntos de cidade** (ver abaixo) |

## Aposentar uma rota de alçada (receita)

Rota que some do sistema não pode ficar boiando em perfil e em `routes_extra`.
São DOIS arquivos, sempre juntos:

1. `lib/ensurePermissionRouteRetirement.js` — entra em `RETIRED_ROUTES` (sai de
   todos) ou em `EXCLUSIVE_ROUTES` (fica em um perfil só).
2. `lib/ensureSignupApprovalSchema.js` — sai da matriz `defaultRoutesForDepartment`.
   Esquecer este passo faz a rota **voltar no boot seguinte** para todo perfil
   com `routes_customized = false`.

Rota que apenas MUDOU de endereço não entra aqui: vai em
`lib/ensurePermissionRouteRenames.js`.


## Próxima feature: conjuntos de cidade nos grants

Decisão de 2026-08-19: **não** vai existir perfil de alçada por cidade. O que
falta é do lado dos DADOS: hoje liberar uma cidade inteira na tela de Alçadas é
um atalho que expande para ids na hora, e a seleção precisa ser refeita a cada
usuário.

O que se quer: **salvar** um conjunto nomeado ("Votuporanga", "Jacarezinho") com
os empreendimentos escolhidos, e depois liberar o conjunto de uma vez — para
não reselecionar tudo toda vez. Empreendimento novo entra no conjunto uma vez
só e todo mundo que tem o conjunto passa a enxergar.

Pontos a resolver quando for implementar:
- o grant continua sendo por EMPREENDIMENTO (auditável) ou passa a ser por
  conjunto? Se for por conjunto, `enterprise_grants` ganha um terceiro
  `subject_type` e o `accessScopeService` resolve a expansão na leitura;
- o que acontece quando alguém sai do conjunto: revoga de todo mundo que tinha
  o conjunto (é o ponto do conjunto "vivo", igual ao perfil vivo);
- conjunto não é cidade de verdade: um conjunto pode misturar cidades, e uma
  cidade pode ter empreendimento fora do conjunto.
