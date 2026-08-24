# Permissões da Microsoft 365 no Office

Arquivo único do que a integração precisa ter concedido no portal do Azure:
o que já está, o que falta, o que está concedido e não serve para nada, e como
conceder cada coisa.

Levantado sobre o código em 24/08/2026 (Meninger-Back). A parte do Outlook veio
de sondagem contra a caixa real; o resto está marcado item a item entre
**medido** (o Graph respondeu) e **documentado** (é o que a Microsoft exige, e
ninguém rodou aqui ainda).

O inventário que a TELA lê é `lib/microsoftScopes.js`. Este arquivo é o passo a
passo humano. **Feature nova que fala com o Graph entra nos dois.**

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
Configurações > Integração Microsoft 365 antes de mexer em qualquer coisa.

**b) A lista de grupos é onde quebra primeiro.** `getMyGroups()` chama
`/me/memberOf` e filtra os grupos Microsoft 365. Se a resposta vier vazia, a tela
diz "sem planos" e parece que o Planner está vazio, quando é permissão faltando.
A menos privilegiada que resolve é **`GroupMember.Read.All`** (`Group.Read.All` e
`Directory.Read.All` também servem, e são mais amplas). *Documentado: confira na
tela de diagnóstico antes de conceder, porque pode já estar coberto.*

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
interruptor está na tela de integração.

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

**Pelo Office**: Configurações > **Integração Microsoft 365**. A lista compara o
que cada tela precisa com o que o token realmente carrega, item por item.

**Pelo laboratório**: Configurações > **Laboratório do Outlook**, rodar a
sondagem. É o único lugar que testa contra o Graph de verdade, e só cobre e-mail.

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
com erro por item. Vá pela tela de diagnóstico, não pela cara da tela.

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
