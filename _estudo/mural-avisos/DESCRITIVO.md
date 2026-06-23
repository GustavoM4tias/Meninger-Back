# Mural de Avisos / Comunicados — Descritivo de Desenvolvimento

> Documento autossuficiente para desenvolver o **Mural de Avisos** do zero, **fora do Academy**
> (módulo próprio dentro do Office). Há um protótipo funcional de backend (Fase 1) em
> `Meninger-Back/_estudo/mural-avisos/` que serve de referência — recriar com namespace próprio
> (sem prefixo `academy`).

---

## 1. Visão e objetivo
Canal interno de **comunicados/avisos** (broadcast), separado da Base de Conhecimento.
Enquanto o **artigo** é referência durável, o **comunicado** é uma mensagem **com prazo e
responsável**, muitas vezes **obrigatória**, que precisa **chegar às pessoas certas** e — quando
crítica — ter **registro de ciência** ("Li e estou ciente") para auditoria.

Exemplos reais do dia a dia:
- "Ligar os infláveis na frente da loja **todo sábado**" — obrigatório e recorrente.
- "Fechamento do período contábil até a data X" — prazo.
- Avisos de diretoria, mudanças de processo, etc.

## 2. Onde construir
**Dentro do Office**, como módulo próprio: **tabelas, rotas, serviços e telas próprias**, sem
acoplar ao Academy. Reaproveitar a infraestrutura já existente do projeto (seção 6).

## 3. Personas e casos de uso
- **Autor/Admin** (RH, diretoria, comunicação, gestor): cria, define público-alvo, publica,
  acompanha aderência, reenvia lembrete.
- **Destinatário** (gestor/funcionário): recebe a notificação, lê no mural, confirma ciência.
- **Auditoria**: consulta quem leu/confirmou e quando (LGPD: IP/UA no registro de ciência).

## 4. Requisitos funcionais
### 4.1 Comunicado
- Campos: **título**, **corpo** (markdown curto), **tipo** (Informativo | Obrigatório | Urgente)
  com ícone/cor, **validade** (início/fim — fora dela some do mural), **fixar** no topo,
  **prioridade**, **exige ciência? (sim/não)**, **canais** (sino / e-mail / WhatsApp), **link** opcional.
- Estados: **Rascunho → Publicado → Arquivado**.
### 4.2 Público-alvo (atribuição = "responsáveis/departamentos")
- Por **escopo**, combinável: **Pessoa | Cargo | Departamento | Cidade | Papel**.
- Na **publicação**, o escopo é **resolvido nos destinatários reais** e **materializado**
  (1 registro por pessoa) — ver decisão na seção 6.
### 4.3 Notificação (ao publicar)
- Dispara para os destinatários: **sino + e-mail** (e **WhatsApp** quando habilitado).
- Comunicação oficial → entrega **garantida** (não-opcional) para os obrigatórios.
### 4.4 Ciência ("Li e estou ciente")
- Botão no card do comunicado. Registra **quem + quando + IP + User-Agent**. Idempotente.
- Só faz sentido quando `exige ciência = true`.
### 4.5 Aderência (admin)
- Painel por comunicado: **total**, **confirmaram × pendentes**, **lista por pessoa**.
- **Reenviar lembrete** apenas aos pendentes.
### 4.6 Lembrete automático
- Scheduler (ex.: **D+1**) reenvia para quem ainda não deu ciência.
### 4.7 Recorrência
- Regra de agendamento (ex.: **todo sábado**) que **republica/relembra** automaticamente.
### 4.8 Mural do usuário
- **Card/banner no painel** com os comunicados ativos do seu público.
- **Badge** de pendências (quantos obrigatórios faltam confirmar).
- **Histórico** de comunicados.

## 5. Modelo de dados (3 tabelas)
**`comunicados`**
- `title`, `body` (markdown), `kind` (INFORMATIVO|OBRIGATORIO|URGENTE)
- `requires_ack` (bool), `pinned` (bool), `priority` (int), `status` (DRAFT|PUBLISHED|ARCHIVED)
- `starts_at`, `ends_at` (validade), `channels` (jsonb: {inapp,email,whatsapp})
- `recurrence` (jsonb — regra de recorrência), `link`
- `published_at`, `created_by_user_id`, `updated_by_user_id`, timestamps
- (opcional) `audiences` (jsonb de tokens) para visibilidade ampla além do público-alvo

**`comunicado_assignments`** (regras de público-alvo)
- `comunicado_id`, `scope_type` (USER|POSITION|DEPARTMENT|CITY|ROLE), `scope_value`
- UNIQUE (comunicado_id, scope_type, scope_value)

**`comunicado_receipts`** (destinatário materializado + ciência)
- `comunicado_id`, `user_id`, `acked_at` (nulo = pendente), `ack_ip`, `ack_user_agent`
- UNIQUE (comunicado_id, user_id)

## 6. Decisões de arquitetura
- **Materializar destinatários na publicação** (receipts): ler o mural, registrar ciência e
  montar a aderência viram **joins simples** (sem reresolver escopo a cada request).
  ⚠️ Trade-off: o público fica **"congelado"** na publicação (quem entra no departamento depois
  não recebe até re-publicar). **Prever** uma ação "atualizar destinatários".
- **Reaproveitar do projeto** (não reinventar):
  - **Resolução de escopo → userIds**: copiar a lógica de
    `services/academy/trackAssignmentService.js → resolveAffectedUserIds` (USER/POSITION/
    DEPARTMENT/CITY/ROLE → consulta `Position`/`Department`/`UserCity`/`User`).
  - **NotificationService** (`services/notification/NotificationService.js`): envio multicanal.
    Padrão: `notify({ type, recipients:{users:[...]}, title, body, data, link, importance })`.
    Adicionar um tipo no catálogo `services/notification/notificationTypes.js` (sino + e-mail;
    WhatsApp tem suporte a template).
  - Padrão **Highlights** (`*/academy/highlight*`) para o CRUD admin + exibição no painel.
  - **Aderência**: espelhar o padrão de `trackAssignmentService.adherence`.

## 7. API (sugestão — espelha o protótipo)
**Admin** (auth + admin):
- `GET /comunicados` (lista, com stats de ciência) · `POST /comunicados`
- `GET /comunicados/:id` · `PATCH /comunicados/:id` · `DELETE /comunicados/:id`
- `PUT /comunicados/:id/assignments` (define público-alvo)
- `POST /comunicados/:id/publish` (resolve destinatários + materializa + notifica)
- `PATCH /comunicados/:id/status` (DRAFT/PUBLISHED/ARCHIVED)
- `GET /comunicados/:id/adherence` (quem confirmou × pendentes)
- `POST /comunicados/:id/remind` (reenviar lembrete aos pendentes) — fase 2

**Usuário** (auth):
- `GET /me/comunicados` (meu mural, com estado de ciência)
- `GET /me/comunicados/pending` (badge)
- `POST /comunicados/:id/ack` (confirmar ciência; captura IP/UA)

## 8. Frontend
- **Admin** (`/comunicados` na área de gestão): lista + editor (tipo, público-alvo por escopo,
  validade, canais, exige-ciência, recorrência, fixar) + **painel de aderência** (com reenvio).
- **Usuário**: mural no painel inicial (cards, fixados/urgentes primeiro), botão **"Li e estou
  ciente"**, **badge** de pendências no menu/sino, **histórico**.

## 9. Fases de entrega
1. **Core:** modelo + CRUD admin + público-alvo + publicar + notificação (sino/e-mail) + mural +
   ciência + aderência básica. *(o protótipo de backend cobre quase tudo disso)*
2. **Engajamento:** lembrete D+1 (scheduler) + painel de aderência completo + reenvio manual.
3. **Avançado:** **recorrência** agendada (ex.: todo sábado) + canal **WhatsApp** + export/relatórios.

## 10. Decisões já tomadas com o usuário
- **"Responsáveis"** = pessoas/gestores **responsáveis pela ação**, de quem se cobra ciência
  (e o painel mostra quem ainda não confirmou).
- O mural deve aparecer onde o usuário está (**Office**; e Academy no futuro). A **notificação**
  chega de qualquer forma (sino/e-mail/WhatsApp).
- Tipos de comunicado: **Informativo, Obrigatório, Urgente**.

## 11. Protótipo de referência (já pronto, desplugado)
`Meninger-Back/_estudo/mural-avisos/`:
- `models/comunicado.js`, `models/comunicadoAssignment.js`, `models/comunicadoReceipt.js`
- `services/comunicadoAdminService.js` (CRUD + público-alvo + publish→materializa+notifica + adherence)
- `services/comunicadoService.js` (listForUser, pendingCount, ack)
- `controllers/comunicadoController.js`
- `README.md` (como estava plugado — tudo já revertido)

**Recriar fora do Academy**: tabelas/rotas/serviço próprios (sem `academy`), reaproveitando os
pontos da seção 6. As tabelas provisórias `academy_comunicado*` foram removidas do banco.
