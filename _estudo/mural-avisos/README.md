# Mural de Avisos / Comunicados — estudo (Fase 1 backend)

> Protótipo extraído do Academy para ser **recriado melhor num chat novo**, **fora do
> Academy** (namespace próprio, não `academy_*`). O código aqui é referência funcional;
> foi **desplugado** do Academy e as tabelas provisórias foram **dropadas**.

## O que é
Broadcast curto (fora da KB) para **comunicados/avisos** com:
- **Público-alvo por escopo** (responsáveis/departamentos): `USER | POSITION | DEPARTMENT | CITY | ROLE`;
- **Confirmação de ciência** ("Li e estou ciente") com registro (IP/UA) — auditoria;
- **Validade** (início/fim), **fixar**, **prioridade**, **tipo** (INFORMATIVO/OBRIGATORIO/URGENTE);
- **Notificação** ao publicar (sino + e-mail; WhatsApp previsto p/ depois);
- **Painel de aderência** (quem confirmou × quem falta).

Decisões de produto já confirmadas com o usuário:
- "Responsáveis" = **pessoas/gestores responsáveis pela ação**, de quem se cobra ciência.
- Mural aparece no **Office e no Academy** (a notificação chega de qualquer forma).

## Decisão de arquitetura central
Ao **publicar**, os escopos (assignments) são **resolvidos nos destinatários reais**
(mesma lógica de `trackAssignmentService.resolveAffectedUserIds`) e **materializados**
em `receipts` (1 linha por destinatário). Assim, ler o mural, registrar ciência e montar
a aderência viram **joins simples** — sem reresolver escopo a cada request. (Trade-off:
o público fica "congelado" na publicação; quem entra no depto depois não recebe até
re-publicar/refresh. Para o rebuild, avaliar um "refresh de destinatários".)

## Modelo de dados (3 tabelas)
- **`comunicados`** — `title`, `body` (markdown), `kind`, `audience`/`audiences` (visibilidade ampla por tokens, opcional), `requiresAck`, `pinned`, `priority`, `status` (DRAFT|PUBLISHED|ARCHIVED), `startsAt`/`endsAt`, `channels` (jsonb inapp/email/whatsapp), `recurrence` (jsonb, ainda não processado), `link`, `publishedAt`, `createdByUserId`, `updatedByUserId`.
- **`comunicado_assignments`** — `comunicadoId`, `scopeType`, `scopeValue`. UNIQUE (comunicado, type, value).
- **`comunicado_receipts`** — `comunicadoId`, `userId`, `ackedAt` (nulo = pendente), `ackIp`, `ackUserAgent`. UNIQUE (comunicado, user).

## API (como estava, prefixo `/academy` — mover p/ namespace próprio)
Admin (interno+admin): `GET/POST /admin/comunicados`, `GET/PATCH/DELETE /admin/comunicados/:id`,
`PUT …/assignments`, `POST …/publish`, `PATCH …/status`, `GET …/adherence`.
Usuário: `GET /comunicados` (meu mural), `GET /comunicados/pending` (badge), `POST /comunicados/:id/ack`.

## Arquivos nesta pasta (referência)
- `models/comunicado.js`, `models/comunicadoAssignment.js`, `models/comunicadoReceipt.js`
- `services/comunicadoAdminService.js` (CRUD + assignments + publish→materializa+notifica + adherence)
- `services/comunicadoService.js` (listForUser, pendingCount, ack)
- `controllers/comunicadoController.js`

## Como ESTAVA plugado no Academy (tudo já REVERTIDO)
1. `models/sequelize/index.js` — import + `db.AcademyComunicado/...Assignment/...Receipt`.
2. `routes/academyRoutes.js` — import do controller + bloco de rotas.
3. `services/notification/notificationTypes.js` — `ACADEMY_COMUNICADO: 'academy.comunicado'` + entrada no catálogo (emailType `generic.notification`, `userOptional:false`).
   Padrão de envio: `NotificationService.notify({ type, recipients:{users:[...]}, title, body, data, link, importance })`.

## Para o rebuild (chat novo)
- Criar **fora do Academy** (tabelas/rotas/serviço próprios; sem prefixo `academy`).
- **Falta o frontend** (não foi feito): Admin (CRUD + público-alvo + aderência) e Mural (card no painel Office+Academy + botão "Li e estou ciente" + badge de pendências).
- **Fases 2–3 previstas:** lembrete D+1 p/ quem não deu ciência (scheduler), **recorrência** (ex.: todo sábado), canal **WhatsApp** (já existe no projeto).
- Reaproveitar do projeto: `services/academy/audience.js` (tokens), `trackAssignmentService` (resolução de escopo + aderência), `NotificationService` + catálogo, padrão Highlights (CRUD admin + painel).
