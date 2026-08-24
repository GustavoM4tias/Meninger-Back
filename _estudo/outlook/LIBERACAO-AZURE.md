# Liberar `Mail.ReadWrite` e `MailboxSettings.Read` no app do Office

O que falta para o módulo de e-mail funcionar por inteiro, e como conceder.
Escrito a partir da sondagem de 24/08/2026, que testou o app de verdade.

---

## O que já funciona e o que falta

O app é o **AppGraphMenin** (`291d3be9-7ec0-48aa-9f4b-598db950a538`), tenant
`9d25b10a-167a-4c5f-a13b-9d4ad1016ff2`.

Sondado com token de aplicação, o resultado foi:

| Operação | Situação | Permissão que responde |
|---|---|---|
| Ler pastas, mensagens, prévia | Funciona | `Mail.Read` (já concedida) |
| Buscar por texto, filtrar | Funciona | `Mail.Read` |
| Baixar anexo | Funciona | `Mail.Read` |
| Sincronização incremental (delta) | Funciona | `Mail.Read` |
| **Enviar e-mail** | Funciona (testado, e-mail entregue) | `Mail.Send` (já concedida) |
| Criar e editar rascunho | **403** | `Mail.ReadWrite` — **falta** |
| Marcar lido, sinalizar, categorizar | **403** | `Mail.ReadWrite` — **falta** |
| Mover de pasta, excluir | **403** | `Mail.ReadWrite` — **falta** |
| Assinatura, fuso, resposta automática | **403** | `MailboxSettings.Read` — **falta** |
| Regras da caixa de entrada | **403** | `MailboxSettings.Read` — **falta** |

São **duas** permissões, as duas do tipo **Aplicação** (não Delegada).

---

## Antes de conceder: o que cada uma dá

Vale ler, porque permissão de aplicação não é por pessoa — vale para o tenant
inteiro, sem consentimento individual de ninguém.

**`Mail.ReadWrite` (Aplicação)** — o app pode criar, alterar, mover e excluir
mensagens em **qualquer caixa da Menin**. É o que falta para o Office ser caixa
de trabalho em vez de vitrine.

**`MailboxSettings.Read` (Aplicação)** — o app pode ler configuração de caixa de
qualquer pessoa: fuso, idioma, horário de trabalho, regras e o texto da resposta
automática. Só leitura.

> `Mail.ReadWrite` inclui o que `Mail.Read` já dá. Depois de concedida, a
> `Mail.Read` vira redundante e pode ser removida na mesma tela — menos
> permissão listada, mesma capacidade.

### O contrapeso do lado do Office

O Graph não limita nada com token de aplicação: `/users/{qualquer-um}/messages`
responde. Quem limita é o nosso código:

- `MicrosoftOutlookController._resolveMailbox()` tira o endereço da caixa do
  usuário autenticado. Nenhuma rota aceita `?mailbox=`, e nenhuma deve passar a
  aceitar.
- As rotas usam `requireCapability('/microsoft/outlook', ...)`, com `view`,
  `organize` e `send` separadas — dá para liberar leitura sem liberar envio.
- `outlook_send_enabled` desliga o envio para todo mundo de uma vez, pela tela
  de configuração, sem deploy.

---

## Passo a passo

Precisa de uma conta com **Administrador Global** ou **Administrador de
Aplicativos na Nuvem**. Sem um desses papéis, o botão de consentimento aparece
desabilitado.

### 1. Abrir o registro do aplicativo

1. Entrar em **https://entra.microsoft.com** (é o portal novo; o antigo
   `portal.azure.com` leva ao mesmo lugar).
2. Menu lateral: **Identidade** → **Aplicativos** → **Registros de aplicativo**.
3. Aba **Todos os aplicativos** (o app pode não estar em "Meus aplicativos").
4. Buscar por **AppGraphMenin**, ou colar o Id do aplicativo:
   `291d3be9-7ec0-48aa-9f4b-598db950a538`.
5. Clicar no nome para abrir.

> Confira no topo se o **Id do aplicativo (cliente)** bate com o número acima.
> Existe mais de um app no tenant e conceder no errado não dá erro nenhum - só
> não funciona.

### 2. Adicionar as permissões

1. Menu do app: **Permissões de API**.
2. **+ Adicionar uma permissão**.
3. Escolher **Microsoft Graph**.
4. Escolher **Permissões de aplicativo**. *(É o passo que mais erra: o padrão da
   tela é "Permissões delegadas", e delegada não serve aqui.)*
5. Na busca, digitar `Mail.ReadWrite` e marcar a caixa.
6. Na mesma tela, digitar `MailboxSettings.Read` e marcar a caixa.
7. **Adicionar permissões**.

Agora as duas aparecem na lista com **"Não concedido para <organização>"** em
laranja. Elas ainda não valem nada.

### 3. Conceder o consentimento

1. Ainda em **Permissões de API**, clicar em
   **Conceder consentimento do administrador para \<sua organização\>**.
2. Confirmar em **Sim**.
3. A coluna **Status** das duas linhas passa a
   **"Concedido para \<organização\>"**, em verde.

O consentimento vale na hora. O token de aplicação em cache no backend do Office
dura até 1 hora, então pode levar esse tempo para o Office enxergar — ou
reinicie o backend para valer no ato.

### 4. Conferir que pegou

Duas formas:

**Pelo Office**: entrar em **Configurações → Integração Microsoft 365**. A lista
compara o que cada tela precisa com o que o token realmente carrega. As linhas do
Outlook devem virar "Liberado".

**Pelo laboratório**: **Configurações → Laboratório do Outlook**, rodar a
sondagem. `Criar rascunho`, `Marcar lido` e `Configurações da caixa` devem sair
do vermelho.

---

## Se algo der errado

**"Conceder consentimento do administrador" está apagado**
Sua conta não tem o papel necessário. Peça a quem tem Administrador Global.

**Concedi e continua 403**
Quase sempre é o token em cache. Reinicie o backend do Office. Se persistir,
confira se marcou **Permissões de aplicativo** e não Delegadas: a lista mostra o
tipo em cada linha.

**Marquei a permissão errada**
Dá para remover na mesma tela (os três pontos na linha → Remover permissão). Não
quebra nada que já esteja rodando, desde que não seja uma das que o Office usa
hoje: `Mail.Read`, `Mail.Send`, `Files.ReadWrite.All`, `Sites.Read.All`,
`Calendars.ReadWrite`, `OnlineMeetings.ReadWrite.All`,
`OnlineMeetingTranscript.Read.All`, `Tasks.ReadWrite.All`, `User.Read.All`.

---

## Uma recomendação separada, para outro dia

A sondagem listou **54 permissões de aplicação** concedidas a este app, entre
elas `Chat.Read.All` (ler toda conversa de Teams da empresa),
`User.ReadWrite.All` (alterar qualquer usuário do diretório),
`Calls.AccessMedia.All` e `Policy.ReadWrite.FedTokenValidation`.

O Office não usa nenhuma dessas quatro. Isso não bloqueia o Outlook, mas o
`MICROSOFT_CLIENT_SECRET` deste app é hoje uma chave que abre muito mais do que
o Office precisa - e ele está em texto puro num `.env` dentro de uma pasta do
OneDrive e nas variáveis do Railway.

Vale uma revisão à parte, com quem administra o tenant, para tirar o que não é
usado. E, no mesmo movimento, trocar o segredo por um **certificado** ou mover
para o **Key Vault**, que é o caminho recomendado pela Microsoft para app com
permissão de aplicação.
