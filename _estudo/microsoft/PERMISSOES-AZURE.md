# Permissões da Microsoft 365 no Office

Arquivo único do que a integração precisa ter concedido no portal do Azure:
o que já está, o que falta, o que está concedido e não serve para nada, e como
conceder cada coisa.

Levantado sobre o código em 24/08/2026 (Meninger-Back). A parte do Outlook veio
de sondagem contra a caixa real; o resto está marcado item a item entre
**medido** (o Graph respondeu) e **documentado** (é o que a Microsoft exige, e
ninguém rodou aqui ainda).

**Este arquivo é a fonte única.** A tela de diagnóstico da integração e o
Laboratório do Outlook foram removidos em 24/08/2026 - a configuração existe, não
muda, e vale pelo padrão do `MicrosoftSettingsService`. Feature nova que fala com
o Graph atualiza aqui.

---

## O app

**AppGraphMenin** - `291d3be9-7ec0-48aa-9f4b-598db950a538`
Tenant `9d25b10a-167a-4c5f-a13b-9d4ad1016ff2`.

Ele carrega duas credenciais diferentes, e confundir as duas é o erro mais caro
deste assunto:

| | Permissão **Delegada** | Permissão de **Aplicação** |
|---|---|---|
| Quem age | a pessoa logada | o Office, sem ninguém na frente |
| Alcance | só o que a pessoa já alcança | a Menin inteira |
| Onde é usada | Agenda, SharePoint, OneDrive, Planner, importar pessoas | Outlook, transcrição de participante, tudo que roda em scheduler |
| Consentimento | do usuário ou do admin | só do admin |

Escopo delegado NOVO no login (`BASE_SCOPES`, em `MicrosoftAuthService.js`) muda
a entrada de TODO MUNDO: se ele exigir aprovação de admin e ainda não estiver
concedido, o login passa a falhar com "need admin approval" para todos. Por isso
o padrão da casa é **conceder no portal primeiro** - o consentimento de
administrador devolve o escopo no token mesmo sem ele estar em `BASE_SCOPES`. É
assim que Planner e importação de pessoas funcionam hoje.

---

## Link direto para a tela de permissões

```
https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/291d3be9-7ec0-48aa-9f4b-598db950a538/isMSAApp~/false
```

O mesmo link vale trocando `entra.microsoft.com` por `portal.azure.com`. Se ele
abrir no app errado (acontece quando a conta tem mais de um tenant), vá pelo
caminho manual descrito em "Passo a passo no portal", mais abaixo, e confira o
Id do aplicativo no topo.

---

## LIBERAR TUDO DE UMA VEZ

Esta é a lista completa: tudo que o Office usa hoje, tudo que ele já tem código
para usar e está esperando, e tudo que destrava funcionalidade que hoje não
existe. Cada linha diz o **tipo** (Aplicação x Delegada), se já está concedida, e
o que ela abre.

Marcações: **[JÁ]** concedida e em uso · **[FALTA]** o código espera e não tem ·
**[NOVO]** destrava funcionalidade que ainda não existe · **[+]** exige mais do
que o consentimento (política, manifesto, código).

### Identidade e pessoas

| Permissão | Tipo | | O que abre |
|---|---|---|---|
| `User.Read` | Delegada | [JÁ] | Entrar com a conta Microsoft. Base de tudo. |
| `User.ReadBasic.All` | Delegada | [FALTA] | Nome de qualquer pessoa da Menin: responsável de tarefa do Planner, participante de reunião, seletor de pessoas. Hoje quem nunca entrou no Office aparece como "Pessoa da equipe". |
| `User.Read.All` | Aplicação | [JÁ] | Importar pessoas do diretório em lote, com cargo e departamento. |
| `Presence.Read.All` | Delegada | [NOVO] | Status do Teams (disponível, ocupado, em reunião, ausente) ao lado do nome, em qualquer tela que liste pessoas. Barato e visível. |
| `User.ReadWrite.All` | Aplicação | [JÁ] | Concedida e **não usada**. Só faria sentido se o Office fosse criar/alterar conta no Azure. Candidata a remoção. |

### Agenda e reuniões

| Permissão | Tipo | | O que abre |
|---|---|---|---|
| `Calendars.ReadWrite` | Delegada | [JÁ] | Ler o calendário, criar, editar, cancelar, série recorrente. |
| `Calendars.Read.Shared` | Delegada | [FALTA] | Ver quem está livre antes de marcar. Sem ela, todo convidado sai cinza. |
| `Calendars.ReadWrite.Shared` | Delegada | [NOVO] | Agenda de quem delegou acesso: secretária marcando pelo diretor, agenda compartilhada de time. Cobre também a de cima. |
| `Place.Read.All` | Delegada | [NOVO] | Salas e recursos: escolher a sala na hora de marcar e saber se está livre. Hoje o campo de local é texto solto. |
| `OnlineMeetings.ReadWrite` | Delegada | [JÁ] | Reunião instantânea com link do Teams. |
| `OnlineMeetings.Read.All` | Aplicação | [FALTA] [+] | Transcrição de reunião que a pessoa só participou, quando ninguém carregou ainda. **Exige política de acesso a aplicativo** (PowerShell do Teams). |
| `OnlineMeetingTranscript.Read.All` | Aplicação | [JÁ] | Baixar a transcrição. |
| `OnlineMeetingRecording.Read.All` | Aplicação | [NOVO] [+] | A **gravação** da reunião, não só o texto. Abre reassistir trecho e anexar o vídeo ao relatório. Mesma política de acesso. |
| `CallRecords.Read.All` | Aplicação | [NOVO] | Relatório de participação: quem entrou, quando saiu, quanto tempo ficou. É o que responde "quem realmente estava na reunião". |

### E-mail (Outlook)

| Permissão | Tipo | | O que abre |
|---|---|---|---|
| `Mail.Read` | Aplicação | [JÁ] | Ler pastas, mensagens, anexos, buscar, sincronizar. |
| `Mail.Send` | Aplicação | [JÁ] | Enviar em nome da pessoa. |
| `Mail.ReadWrite` | Aplicação | [FALTA] | Rascunho, marcar lido, sinalizar, categorizar, **mover entre pastas**, excluir, **criar e renomear pasta**. É o que falta para o Office ser caixa de trabalho e não vitrine. Inclui o que `Mail.Read` já dá. |
| `MailboxSettings.Read` | Aplicação | [FALTA] | Ler assinatura, fuso, horário de trabalho, resposta automática e regras. |
| `MailboxSettings.ReadWrite` | Aplicação | [NOVO] | **Ligar** resposta automática e mexer em regra pela tela do Office (a de cima só lê). É o que permite "vou viajar, ativa meu fora do escritório" pela Eme. |
| `Contacts.Read` | Delegada | [NOVO] | Catálogo de contatos da pessoa no autocompletar de destinatário. Hoje só sugere quem está no Office. |

### Arquivos (SharePoint e OneDrive)

| Permissão | Tipo | | O que abre |
|---|---|---|---|
| `Sites.ReadWrite.All` | Delegada | [JÁ] | Navegar em site e biblioteca, e também **listas** do SharePoint (que o Office ainda não usa - é funcionalidade a construir, não permissão a pedir). |
| `Files.ReadWrite.All` | Delegada | [JÁ] | Enviar, renomear, mover, excluir, link de compartilhamento, OneDrive, "compartilhados comigo" e a API de planilha (que exige ReadWrite mesmo só para ler célula). |
| `Sites.Manage.All` | Delegada | [NOVO] | Criar biblioteca e pasta estruturada por empreendimento, e mexer em coluna de lista. Só se o Office for organizar o SharePoint, não só usá-lo. |
| `Files.ReadWrite.All` | Aplicação | [JÁ] | Rotina sem usuário mexendo em arquivo (relatório que se salva sozinho na pasta do empreendimento). |

### Teams como canal de mensagem

Aqui a escolha é de produto antes de ser de portal. **Peça as três primeiras** se
quiser o caminho completo (notificação do Office + mensagem com pessoa na tela).

| Permissão | Tipo | | O que abre |
|---|---|---|---|
| `TeamsActivity.Send` | Aplicação | [NOVO] [+] | Notificação no feed do Teams **em nome do Office**: cobrança de checklist, alerta de reserva cancelada, aviso de fechamento. É o caminho suportado pela Microsoft. **Exige o Office registrado como app do Teams** (manifesto). |
| `TeamsAppInstallation.ReadWriteForUser.All` | Aplicação | [NOVO] [+] | Instalar esse app do Teams para a pessoa sem ela precisar fazer nada. Sem isto, cada um teria que instalar na mão antes de receber a primeira notificação. |
| `Chat.Create` | Delegada | [NOVO] | Abrir a conversa de chat quando ela ainda não existe. |
| `ChatMessage.Send` | Delegada | [NOVO] | Mandar mensagem **em nome da pessoa que está na tela**. Serve para "avisa o fulano daqui", não serve para rotina automática. |
| `Chat.ReadWrite.All` | Aplicação | [NOVO] | Escrever em qualquer conversa da empresa. Resolve tudo e é a mais ampla das cinco - só peça se descartar o caminho do app do Teams. |
| `ChannelMessage.Send` | Delegada | [NOVO] | Postar em canal de equipe (mural de time). Webhook de canal faz parecido sem permissão nenhuma. |
| `Team.ReadBasic.All` + `Channel.ReadBasic.All` | Delegada | [NOVO] | Listar equipes e canais para a pessoa escolher o destino. |
| `Chat.Read.All` | Aplicação | [JÁ] | **Concedida e não usada.** Lê toda conversa de Teams da empresa. Se o Teams como canal não for por aqui, esta é a primeira a sair. |

### Tarefas (Planner e To Do)

| Permissão | Tipo | | O que abre |
|---|---|---|---|
| `Tasks.ReadWrite` | Delegada | [JÁ, informal] | O quadro do Planner. Funciona hoje só porque o consentimento de administrador devolve o escopo - não é pedido no login. Formalizar tira a fragilidade. |
| `GroupMember.Read.All` | Delegada | [FALTA] | A lista de grupos que têm plano. Sem ela a tela diz "sem planos" e parece Planner vazio. |
| `Group.ReadWrite.All` | Delegada | [NOVO] | **Comentário de tarefa do Planner** (que por baixo é conversa do grupo) e criar plano novo. É uma permissão ampla: pesa. |
| `Tasks.ReadWrite.All` | Aplicação | [JÁ] | Concedida. Antes de contar com ela para importar planos e aposentar o Planner, confirme que o Planner aceita permissão de aplicação no v1.0 - historicamente valia para o To Do, não para o Planner. |

### Assinaturas e diretório

| Permissão | Tipo | | O que abre |
|---|---|---|---|
| (nenhuma nova) | | | As assinaturas de mudança usam as mesmas permissões da leitura. O que falta é `PUBLIC_API_URL` e `ENABLE_GRAPH_SUBSCRIPTIONS=true`, não permissão. |
| `Directory.Read.All` | Delegada | [NOVO] | Cobre de uma vez `User.ReadBasic.All` e `GroupMember.Read.All`. Mais ampla; peça só se preferir uma linha a duas. |

### O que NÃO adianta pedir

- `Calls.AccessMedia.All` e `Policy.ReadWrite.FedTokenValidation`: concedidas, sem uso e sem plano de uso. Removê-las.
- Qualquer permissão para o **Office Online abrir arquivo interno em iframe**: não existe. O iframe do Office Viewer exige arquivo público, e é por isso que a prévia de planilha foi feita pela API de pastas de trabalho.
- Qualquer permissão para ler `.xls` antigo pela API de planilha: ela só abre `.xlsx`. Converter é a saída.

---

## Placar: o que falta, por prioridade

| # | Para quê | Permissão | Tipo | Status |
|---|---|---|---|---|
| 1 | Outlook: rascunho, marcar, mover, excluir | `Mail.ReadWrite` | Aplicação | **falta** (medido: 403) |
| 2 | Outlook: assinatura, resposta automática, regras | `MailboxSettings.Read` | Aplicação | **falta** (medido: 403) |
| 3 | Ver quem está livre antes de marcar reunião | `Calendars.Read.Shared` | Delegada | **falta** (documentado) |
| 4 | Nome e escolha de responsável no Planner | `User.ReadBasic.All` | Delegada | **falta** (documentado) |
| 5 | Lista de grupos com plano (Planner) | `GroupMember.Read.All` | Delegada | **conferir** (documentado) |
| 6 | Transcrição para quem só participou | `OnlineMeetings.Read.All` + política de acesso | Aplicação | **falta** (documentado) |
| 7 | Teams como quarto canal de mensagem | ver a seção própria | depende do caminho | **falta**, e é uma decisão antes de ser um clique |

SharePoint, OneDrive, planilha na nuvem, agenda, reunião instantânea, upload,
link de compartilhamento e importação de pessoas **não precisam de nada novo**.
O que ainda falha nesses lugares não é permissão - está dito abaixo, em cada um.

---

## 1 e 2. Outlook

Sondado com token de aplicação em 24/08/2026, contra a caixa real. **Medido.**

| Operação | Situação | Permissão |
|---|---|---|
| Ler pastas, mensagens, prévia | Funciona | `Mail.Read` (concedida) |
| Buscar por texto, filtrar | Funciona | `Mail.Read` |
| Baixar anexo | Funciona | `Mail.Read` |
| Sincronização incremental (delta) | Funciona | `Mail.Read` |
| **Enviar e-mail** | Funciona (e-mail entregue no teste) | `Mail.Send` (concedida) |
| Criar e editar rascunho | **403** | `Mail.ReadWrite` - falta |
| Marcar lido, sinalizar, categorizar | **403** | `Mail.ReadWrite` - falta |
| Mover de pasta, excluir | **403** | `Mail.ReadWrite` - falta |
| Assinatura, fuso, resposta automática | **403** | `MailboxSettings.Read` - falta |
| Regras da caixa de entrada | **403** | `MailboxSettings.Read` - falta |

Em uma frase: **o Office lê e envia, mas ainda não altera a caixa.**

**`Mail.ReadWrite` (Aplicação)** - criar, alterar, mover e excluir mensagem em
qualquer caixa da Menin. É o que falta para o Office ser caixa de trabalho em vez
de vitrine. Inclui o que `Mail.Read` já dá: depois de concedida, a `Mail.Read`
vira redundante e pode sair da lista.

**`MailboxSettings.Read` (Aplicação)** - ler configuração de caixa de qualquer
pessoa: fuso, idioma, horário de trabalho, regras e o texto da resposta
automática. Só leitura.

### O contrapeso, do lado do Office

Com token de aplicação o Graph não limita nada: `/users/{qualquer-um}/messages`
responde. Quem limita é o nosso código:

- `MicrosoftOutlookController._resolveMailbox()` tira o endereço da caixa do
  usuário autenticado. Nenhuma rota aceita `?mailbox=`, e nenhuma deve passar a
  aceitar.
- As rotas usam `requireCapability('/microsoft/outlook', ...)`, com `view`,
  `organize` e `send` separadas.
- `outlook_send_enabled` desliga o envio para todo mundo pela tela, sem deploy.
- A tool `search_email` da Eme obedece a mesma regra: a caixa vem do usuário, e
  argumento do modelo nunca escolhe caixa.

---

## 3. Disponibilidade: o gerador de reuniões

O botão "ver quem está livre" do modal de reunião e a tool `check_availability`
da Eme chamam `POST /me/calendar/getSchedule`.

`Calendars.ReadWrite`, que o login já pede, cobre a agenda **da própria pessoa**.
O getSchedule lê o livre/ocupado **das outras**, e para isso a Microsoft exige a
variante compartilhada: **`Calendars.Read.Shared`** (`Calendars.ReadWrite.Shared`
também serve). *Documentado, não sondado.*

**Como o sintoma aparece:** não é um 403 na tela. O Graph responde 200 e devolve,
por agenda consultada, um `error` no lugar dos blocos ocupados. O código já trata
isso (`MicrosoftTeamsService.getSchedule` guarda `s.error?.message`) e a etiqueta
do convidado fica **cinza**, com o resumo dizendo "N agenda(s) sem resposta".
Então: **se todo convidado sai cinza, é esta permissão.** Se sai verde ou
vermelho, ela já está no token e não há nada a fazer.

`Calendars.Read.Shared` é consentível pelo próprio usuário, mas conceda no portal
mesmo assim - assim ela entra no token de quem já está logado, sem tocar em
`BASE_SCOPES` e sem uma tela de consentimento nova para a empresa inteira.

---

## 4 e 5. Planner

O quadro roda **só com o token da pessoa**. Quatro coisas para saber:

**a) `Tasks.ReadWrite` não é pedida no login.** O Planner só funciona porque o
consentimento de administrador feito no portal devolve o escopo assim mesmo. Está
concedido e funciona - mas é frágil: uma revisão de permissões pela TI derruba a
tela sem aviso, e o que chega no usuário é um 403 genérico. Confira em
a lista de permissões no portal antes de mexer em qualquer coisa.

**b) A lista de grupos é onde quebra primeiro.** `getMyGroups()` chama
`/me/memberOf` e filtra os grupos Microsoft 365. Se a resposta vier vazia, a tela
diz "sem planos" e parece que o Planner está vazio, quando é permissão faltando.
A menos privilegiada que resolve é **`GroupMember.Read.All`** (`Group.Read.All` e
`Directory.Read.All` também servem, e são mais amplas). *Documentado: pode já estar coberto pelo consentimento de administrador -
se a lista de grupos aparece, está.*

**c) Responsável só existe para quem já entrou no Office.** O id de um assignment
do Planner é o id do Azure, e ele vem da nossa tabela `users.microsoft_id`. Quem
nunca entrou no Office pela Microsoft não aparece no seletor, e quem foi posto na
tarefa pelo Planner de verdade aparece como "Pessoa da equipe". **`User.ReadBasic.All`**
(que a importação de pessoas já usa) resolve os dois lados: nome de qualquer
pessoa do diretório e atribuição para quem não é do Office.

**d) Permissão concedida que pode não funcionar.** `Tasks.ReadWrite.All`
(Aplicação) está concedida ao app e o Office não a usa. Antes de contar com ela
para importar os planos e aposentar o Planner (a decisão de 23/06), confirme que
o Planner aceita permissão de aplicação no Graph v1.0: historicamente não
aceitava, e `Tasks.*` de aplicação valia para o To Do, não para o Planner. Sem
isso, aposentar o Planner por rotina automática não sai do papel.

---

## 6. Transcrição de quem só participou

O caminho de aplicação já está implementado: quando a conta da pessoa não alcança
a reunião, o Office tenta pelo organizador (`/users/{organizador}/onlineMeetings`).

Precisa de duas coisas, e a segunda não é um botão no portal:

1. **`OnlineMeetings.Read.All` (Aplicação)** - `OnlineMeetingTranscript.Read.All`
   já está concedida.
2. Uma **política de acesso a aplicativo** no tenant, criada por PowerShell do
   Teams (`New-CsApplicationAccessPolicy` + `Grant-CsApplicationAccessPolicy`),
   autorizando este app a ler reunião em nome dos usuários. Sem ela o Graph
   responde 403 mesmo com a permissão concedida - é o caso clássico de
   "permissão concedida que não funciona sozinha".

Sem os dois, o caminho pelo Graph continua valendo só para o organizador. O
interruptor é o `transcript_app_fallback` do MicrosoftSettingsService, que já vem ligado por padrão.

**Mas existe um terceiro caminho, e ele já está no ar** (24/08/2026): a
transcrição tem id próprio no Graph e é a MESMA para todo mundo que esteve na
sala. Quando alguém já carregou a reunião no Office, quem só participou passa a
ver aquela transcrição e aquele relatório, sem chamar o Graph e sem gerar
relatório novo - o que também economiza token de IA, porque o mesmo conteúdo não
é resumido duas vezes. O direito de ver vem da lista de participantes do registro
salvo (`MicrosoftTranscriptService.participou`), nunca do id vindo da URL.

Ou seja: a permissão acima resolve o caso de **ninguém** ter carregado a reunião
ainda. Deixou de ser bloqueio para o dia a dia, e virou conveniência.

---

## 7. Teams como quarto canal de mensagem

O app tem **`Chat.Read.All`** - ler toda conversa de Teams da empresa - e
**nenhuma permissão de escrita**. É o desequilíbrio mais feio do registro: o
Office lê tudo e não consegue mandar uma mensagem.

São três caminhos diferentes, e a escolha é de produto antes de ser de portal:

**A. Delegado: `Chat.Create` + `ChatMessage.Send`**
A mensagem sai **em nome da pessoa** que está na tela. Serve para "avisar o
fulano daqui", não serve para cobrança de checklist nem alerta de reserva
cancelada, que rodam em scheduler, sem ninguém logado. As duas são consentíveis
pelo usuário. É o caminho barato e o que resolve menos.

**B. Aplicação: `TeamsActivity.Send`**
Notificação no feed de atividades do Teams, **em nome do Office**. É o caminho
que a Microsoft suporta para "avisar uma pessoa". Exige, além da permissão,
registrar o Office como app do Teams (manifesto e app instalado no escopo pessoal
de quem vai receber). É mais trabalho fora do código do que dentro.

**C. Aplicação: `Chat.ReadWrite.All`**
Escrever em qualquer conversa da empresa. Resolve tudo e é a mais ampla das três,
logo depois de a sondagem mostrar que este app já lê demais. Se for por aqui,
vale conferir antes o modelo de cobrança das APIs de mensagem do Teams com
permissão de aplicação - parte delas é medida e faturada no Azure.

**Webhook de canal** (sem permissão nenhuma) resolve aviso em canal e não resolve
mensagem para uma pessoa, que é justamente o caso de cobrança e alerta.

**Recomendação:** B para notificação do Office, e A só se aparecer um caso com
pessoa na frente. E, no mesmo movimento, **remover `Chat.Read.All`**: o Office
não a usa, e ela é hoje a permissão mais perigosa do app.

---

## O que NÃO precisa de permissão nova

Vale escrever, porque a suposição contrária custa tempo:

**SharePoint (navegar, buscar, prévia, upload, renomear, mover, excluir, link)**
`Sites.ReadWrite.All` e `Files.ReadWrite.All`, as duas concedidas e pedidas no
login. O upload grande vai por sessão do Graph, que usa a mesma permissão.

**Ler planilha sem baixar (API de pastas de trabalho)**
`Files.ReadWrite.All` cobre. A API do Excel exige ReadWrite mesmo só para ler
célula ou intervalo, porque ela abre sessão no arquivo - e é por isso que ler
planilha não é uma permissão a menos do que escrever nela. O que ainda falha aqui
**não é permissão**: `.xls` antigo (a API só abre `.xlsx`), arquivo com rótulo de
confidencialidade e arquivo travado por alguém no Office Online. Os três já têm
mensagem própria no cliente Graph.

**OneDrive e "compartilhados comigo"**
`/me/drive` e `/me/drive/sharedWithMe` cabem em `Files.ReadWrite.All`, inclusive
abrir o arquivo na biblioteca de ORIGEM de quem compartilhou (que é o que o
`driveId` de origem resolve). O limite que sobra também não é permissão: o Graph
não lista em "compartilhados comigo" o que veio por link avulso, nem o que a
pessoa alcança por ser membro de um site - isso aparece na navegação por site.

**Agenda, reunião instantânea, criar e editar evento**
`Calendars.ReadWrite` e `OnlineMeetings.ReadWrite`, pedidas no login.

**Aviso de reunião com o Office fechado**
Nenhuma permissão nova: o scheduler lê a agenda com o token de cada pessoa e
dispara pelos canais que já existem. O buraco dele é outro - quem está com o
refresh token morto (senha trocada, 90 dias sem uso) simplesmente para de ser
avisado, e isso aparece no estado de conexão da tela, não aqui.

**Assinaturas de mudança (a Microsoft avisar em vez de o Office perguntar)**
Usam as mesmas permissões da leitura. O que falta não é permissão, é
`PUBLIC_API_URL` com o endereço HTTPS público do backend, mais
`ENABLE_GRAPH_SUBSCRIPTIONS=true`. Em ambiente local não funciona: a Microsoft
não alcança a máquina, e o serviço recusa criar a assinatura em vez de criar algo
surdo.

**Importar pessoas da organização**
`User.ReadBasic.All` já vem pelo consentimento de administrador. Mesma permissão
do item 4 do placar: concedê-la formalmente resolve os dois de uma vez.

---

## Passo a passo no portal

Precisa de **Administrador Global** ou **Administrador de Aplicativos na Nuvem**.
Sem um desses papéis o botão de consentimento aparece desabilitado.

### 1. Abrir o registro do aplicativo

1. Entrar em **https://entra.microsoft.com** (o `portal.azure.com` leva ao mesmo
   lugar).
2. Menu lateral: **Identidade** > **Aplicativos** > **Registros de aplicativo**.
3. Aba **Todos os aplicativos** (o app pode não estar em "Meus aplicativos").
4. Buscar **AppGraphMenin**, ou colar o Id `291d3be9-7ec0-48aa-9f4b-598db950a538`.
5. Conferir no topo se o **Id do aplicativo (cliente)** bate. Existe mais de um
   app no tenant, e conceder no errado não dá erro nenhum - só não funciona.

### 2. Adicionar as permissões

1. Menu do app: **Permissões de API** > **+ Adicionar uma permissão** >
   **Microsoft Graph**.
2. Escolher o tipo certo. **É o passo que mais erra**: o padrão da tela é
   "Permissões delegadas". Confira na coluna de tipo, linha por linha:
   - **Permissões de aplicativo**: `Mail.ReadWrite`, `MailboxSettings.Read`,
     `OnlineMeetings.Read.All`, e a do Teams se for pelo caminho B ou C.
   - **Permissões delegadas**: `Calendars.Read.Shared`, `User.ReadBasic.All`,
     `GroupMember.Read.All`, e as do Teams se for pelo caminho A.
3. Marcar e **Adicionar permissões**. Elas aparecem como
   "Não concedido para <organização>", em laranja, e ainda não valem nada.

### 3. Conceder o consentimento

1. Ainda em **Permissões de API**, clicar em **Conceder consentimento do
   administrador para sua organização** e confirmar em **Sim**.
2. A coluna **Status** vira "Concedido para <organização>", em verde.

Vale na hora. O token de aplicação em cache no backend dura até 1 hora, então
pode levar esse tempo para o Office enxergar - ou reinicie o backend.

Escopo **delegado** só entra no token na próxima renovação: peça para a pessoa
sair e entrar de novo se quiser ver na hora.

### 4. Conferir que pegou

Não existe mais tela de diagnóstico no Office (removida em 24/08/2026: a
configuração não muda, e tela para isso era peso sem uso). A conferência é em
dois lugares:

**No portal**: a coluna **Status** de cada linha em Permissões de API precisa
dizer "Concedido para <organização>", em verde. Confira também a coluna de
**tipo** - Aplicação e Delegada aparecem misturadas na mesma lista.

**Na prática, pela funcionalidade**: cada permissão desta lista tem um sintoma
próprio, e a coluna "sintoma sem ela" é o teste. Mover um e-mail de pasta,
marcar uma reunião e ver os convidados ficarem verdes ou vermelhos, abrir o
Planner e ver a lista de grupos. Se o comportamento mudou, pegou.

---

## Se algo der errado

**"Conceder consentimento do administrador" está apagado**
Sua conta não tem o papel necessário. Peça a quem tem Administrador Global.

**Concedi e continua 403**
Quase sempre é cache: token de aplicação até 1 hora (reinicie o backend), token
delegado até a próxima renovação (saia e entre de novo). Se persistir, confira o
tipo da permissão - Aplicação e Delegada aparecem misturadas na mesma lista.

**Concedi e a tela continua vazia, sem erro**
É o caso do Planner e da disponibilidade: eles não dão 403, dão resposta vazia ou
com erro por item. Teste a funcionalidade em si (a coluna de sintoma acima),
não a cara da tela.

**Marquei a permissão errada**
Dá para remover na mesma tela (três pontos na linha > Remover permissão). Não
quebra nada que já esteja rodando, desde que não seja uma das que o Office usa
hoje: `Mail.Read`, `Mail.Send`, `Files.ReadWrite.All`, `Sites.ReadWrite.All`,
`Sites.Read.All`, `Calendars.ReadWrite`, `OnlineMeetings.ReadWrite`,
`OnlineMeetingTranscript.Read.All`, `Tasks.ReadWrite`, `User.Read.All`,
`User.Read`.

---

## A recomendação que continua de pé

A sondagem listou **54 permissões de aplicação** concedidas a este app, entre elas
`Chat.Read.All` (ler toda conversa de Teams da empresa), `User.ReadWrite.All`
(alterar qualquer usuário do diretório), `Calls.AccessMedia.All` e
`Policy.ReadWrite.FedTokenValidation`. **O Office não usa nenhuma dessas quatro.**

O `MICROSOFT_CLIENT_SECRET` deste app é hoje uma chave que abre muito mais do que
o Office precisa, e está em texto puro num `.env` dentro de uma pasta do OneDrive
e nas variáveis do Railway. Os tokens de cada pessoa já foram cifrados; a chave
mestra do tenant ficou do lado, sem cifra.

Vale uma revisão à parte com quem administra o tenant, para tirar o que não é
usado, e no mesmo movimento trocar o segredo por **certificado** ou **Key Vault**,
que é o caminho recomendado pela Microsoft para app com permissão de aplicação.

Se o Teams como canal não for prioridade, `Chat.Read.All` é a primeira a sair.
