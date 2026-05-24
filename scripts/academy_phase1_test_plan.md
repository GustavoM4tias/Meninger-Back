# Academy — Plano de teste manual da Fase 1

Roteiro para validar a estabilização do Academy antes de seguir para a Fase S1 (Compliance Base).

---

## 0. Pré-requisitos

- Backend rodando localmente (`npm run dev` em `Meninger-Back`)
- Frontend rodando localmente (`npm run dev` em `Meninger-Front`)
- Acesso a `psql` apontando para o mesmo banco que o backend usa
- 3 usuários de teste no banco:
  - **A**: `role='admin'`
  - **G**: `role='user'`, `position` que esteja em `positions` (ex: "Gestor Comercial")
  - **U**: `role='user'`, posição comum

---

## 1. Subir backend (schema é aplicado automaticamente)

O projeto usa `sync({ alter: true })` em vez de migrations CLI (memory: `feedback_sequelize_alter`). Toda a evolução de schema do Academy roda automaticamente no boot via `lib/ensureAcademySchema.js`:

- Dedup de `academy_user_progress` e `academy_user_track_progress`
- Drop da UNIQUE antiga em `academy_user_quiz_attempts` (era `(user, track, item)`)
- Add das colunas `attempt_number`, `score_percent` com backfill
- Recreate da UNIQUE nova `(user, track, item, attempt_number)`
- Garante todos os índices que os models declaram

```bash
cd Meninger-Back
npm install        # se ainda não instalou qrcode (S1)
npm run dev        # boot aplica tudo
```

Conferir no log:
- `🔧 [AcademySchema] Pre-sync: N patch(es) aplicado(s)` (no primeiro boot pós-S2)
- `✅ AcademyUserQuizAttempt sincronizado.`
- `✅ [AcademySchema] Pos-sync: N índice(s) garantido(s)`

Validar no banco:
```sql
\d academy_user_progress
\d academy_user_track_progress
\d academy_user_quiz_attempts
```
- `academy_user_progress_user_track_item_unique` (Fase 1)
- `academy_user_track_progress_user_track_unique` (Fase 1)
- `academy_user_quiz_attempts_user_track_item_attempt_unique` (S2.3)
- Colunas `attempt_number`, `score_percent` em `academy_user_quiz_attempts`

---

## 2. Subir backend e ver `sync` aplicar

Ao subir, deve ver no log o `sync({alter:true})` rodando sem reclamar de duplicatas. Se reclamar, repetir passo 1.

---

## 3. Bug 2.3 — KB modo admin protegido

**Como aluno U** (`role=user`):
```bash
curl -H "Authorization: Bearer <TOKEN_U>" \
  "http://localhost:3000/api/academy/kb/articles?mode=admin&status=DRAFT"
```
**Esperado:** `403 Acesso restrito ao administrador.`

**Como admin A:**
```bash
curl -H "Authorization: Bearer <TOKEN_A>" \
  "http://localhost:3000/api/academy/kb/articles?mode=admin&status=DRAFT"
```
**Esperado:** `200` com lista (pode estar vazia).

**Como aluno U com só `?status=PUBLISHED`** (sem mode):
**Esperado:** `200` (não rejeita mais — UX corrigida AUD-4).

---

## 4. Bug 2.1 — Quiz server-side

### 4.1 Setup
1. Como admin A, criar trilha "Teste Quiz" via `/academy/admin/tracks/new`.
2. Adicionar 1 item tipo QUIZ com payload:
   ```json
   {
     "quiz": {
       "title": "Capital do Brasil",
       "questions": [
         {
           "text": "Qual a capital do Brasil?",
           "options": ["São Paulo", "Brasília", "Rio de Janeiro", "Salvador"],
           "correctIndex": 1
         }
       ]
     }
   }
   ```
3. Publicar a trilha.
4. Atribuir USER scope para usuário U (`scopeType=USER`, `scopeValue=<id-de-U>`).

### 4.2 Conferir que correctIndex NÃO vaza
```bash
curl -H "Authorization: Bearer <TOKEN_U>" \
  "http://localhost:3000/api/academy/tracks/teste-quiz" | jq '.items[0].payload'
```
**Esperado:** payload com `quiz.questions[0]` SEM `correctIndex` nem `correct_index`.

### 4.3 Rodar smoke test automatizado
```bash
export ACADEMY_API=http://localhost:3000
export ACADEMY_TOKEN=<TOKEN_U>
export TRACK_SLUG=teste-quiz
export ITEM_ID=<id-do-item>
export EXPECTED_CORRECT_INDEX=1
node scripts/academy_quiz_smoke_test.js
```
**Esperado:** 4/4 passou.

### 4.4 Conferir UX no front
1. Logar como U em `academy.menin.com.br`
2. Abrir trilha "Teste Quiz", abrir item quiz
3. Marcar "São Paulo" (resposta errada) e enviar
4. **Esperado:** badge "revisar" + texto "Sua resposta: São Paulo • Correta: Brasília"
5. Trocar para "Brasília", enviar de novo (vai chamar API novamente)
6. **Esperado:** badge "aprovado" + todas marcadas como corretas

---

## 5. Bug 2.4 — UNIQUE em progress (idempotência do upsert)

Como U, abrir trilha "Teste Quiz", marcar o item como concluído **duas vezes seguidas** clicando "concluir" e desfazendo. Conferir:
```sql
SELECT user_id, track_slug, item_id, COUNT(*)
FROM academy_user_progress
WHERE user_id = <id-U> AND track_slug = 'teste-quiz'
GROUP BY 1,2,3 HAVING COUNT(*) > 1;
```
**Esperado:** 0 linhas.

---

## 6. Bug 2.5 — Ranking global

Como U:
```bash
curl -H "Authorization: Bearer <TOKEN_U>" \
  "http://localhost:3000/api/academy/users/rank?page=1&pageSize=5" | jq
```
**Esperado:** primeiros 5 usuários ordenados por `score` desc; cada um com campo `rank` (1..5).

Page 2:
```bash
curl ... "?page=2&pageSize=5" | jq
```
**Esperado:** próximos 5 com `rank` 6..10 (continuação contínua, não reset).

---

## 7. Bug 3.5 — Reorder track items

Trilha "Teste Quiz" com 1 item. Adicionar mais 2 itens. Tentar:
```bash
curl -X PATCH -H "Authorization: Bearer <TOKEN_A>" \
  -H "Content-Type: application/json" \
  -d '{"order":[<id1>,<id2>]}' \
  "http://localhost:3000/api/academy/tracks-admin/teste-quiz/items/reorder"
```
**Esperado:** `400 Ordem precisa conter todos os itens da trilha (recebido: 2, esperado: 3).`

Com array completo (3 IDs):
**Esperado:** `200 OK`, items reordenados.

Com duplicata `[id1, id1, id2]`:
**Esperado:** `400 Ordem contém IDs duplicados.`

---

## 8. Bug 3.1 — Highlights CRUD admin

Como admin A:
```bash
# Criar
curl -X POST -H "Authorization: Bearer <TOKEN_A>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Teste","type":"LINK","target":"https://menin.com.br","audience":"BOTH","priority":1}' \
  "http://localhost:3000/api/academy/admin/highlights"

# Listar
curl -H "Authorization: Bearer <TOKEN_A>" \
  "http://localhost:3000/api/academy/admin/highlights"

# Toggle active
curl -X PATCH -H "Authorization: Bearer <TOKEN_A>" \
  -H "Content-Type: application/json" \
  -d '{"active":false}' \
  "http://localhost:3000/api/academy/admin/highlights/<id>/active"

# Deletar
curl -X DELETE -H "Authorization: Bearer <TOKEN_A>" \
  "http://localhost:3000/api/academy/admin/highlights/<id>"
```

Como U (aluno):
**Esperado:** todas as chamadas acima → `403`.

---

## 9. Bug 3.3 — Upvote idempotente e impedindo voto próprio

Setup: tópico T criado por U1, post P criado por U2.

**Como U1 (autor do tópico, vota em P):**
```bash
curl -X POST -H "Authorization: Bearer <TOKEN_U1>" \
  "http://localhost:3000/api/academy/community/posts/<id-P>/upvote"
```
**Esperado:** `{ok:true, upvoted:true, upvotes:1}`.

Repetir o mesmo POST:
**Esperado:** `{ok:true, upvoted:true, upvotes:1}` (idempotente, sem erro).

**Como U2 (autor do post, vota em si):**
```bash
curl -X POST -H "Authorization: Bearer <TOKEN_U2>" \
  "http://localhost:3000/api/academy/community/posts/<id-P>/upvote"
```
**Esperado:** `400 Você não pode votar no próprio post.`

**Remover voto de U1:**
```bash
curl -X DELETE -H "Authorization: Bearer <TOKEN_U1>" \
  "http://localhost:3000/api/academy/community/posts/<id-P>/upvote"
```
**Esperado:** `{ok:true, upvoted:false, upvotes:0}`.

---

## 10. Notificações Academy disparando

### 10.1 Resposta em tópico
U1 cria tópico. U2 responde. U1 deve receber notificação `academy.topic.replied` (verificar sino in-app e a tabela `notifications` no banco).

### 10.2 Track atribuída
Admin atribui trilha a USER U via `/tracks-admin/teste-quiz/assignments`. U deve receber `academy.track.assigned`.

### 10.3 Artigo publicado
Admin cria artigo DRAFT e publica via `PATCH /kb/articles/:id/publish`. Audience `BOTH` → todos os users ativos recebem `academy.article.published`.

### 10.4 Trilha concluída
U marca último item required como completo. U recebe `academy.track.completed`.

**Conferência no banco:**
```sql
SELECT user_id, type, title, created_at
FROM notifications
WHERE type LIKE 'academy.%'
ORDER BY created_at DESC LIMIT 20;
```

---

## 11. Bug 3.4 (regressão consertada AUD-1) — Admin vê trilha BOTH

Admin A marca progresso em trilha com `audience='BOTH'`. **Antes do fix AUD-1, daria erro** porque `audienceWhere('ADM_ONLY')` excluía BOTH. Agora:

```bash
curl -X POST -H "Authorization: Bearer <TOKEN_A>" \
  -H "Content-Type: application/json" \
  -d '{"itemId":<id>,"completed":true}' \
  "http://localhost:3000/api/academy/tracks/<slug-BOTH>/progress"
```
**Esperado:** `200 OK` com `progressPercent` atualizado.

---

## 12. S1 — Certificado emitido na conclusão

Como U, concluir TODOS os items required de uma trilha. **Esperado:**
- Response do `markProgress` contém `certificate: { code, ... }`
- `GET /academy/cert/my` lista o certificado
- `GET /academy/cert/verify/:code` (sem auth!) retorna `valid:true`
- `GET /academy/cert/pdf/:code` baixa PDF A4 landscape com QR code apontando para `/cert/CODE`
- Notificação `academy.track.completed` chegou para U com link `?cert=CODE`

Como admin: `DELETE /academy/admin/cert/:code` revoga. Re-verifica:
- `verify` retorna `valid:false, status:REVOKED`

## 13. S1 — Audience server-side

Aluno U manda `?audience=ADM_ONLY` na URL:
```bash
curl -H "Authorization: Bearer <TOKEN_U>" "http://localhost:3000/api/academy/kb/articles?audience=ADM_ONLY"
```
**Esperado:** lista apenas artigos BOTH (servidor IGNORA o query string).

## 14. S1 — Trilhas obrigatórias com deadline

Admin cria assignment com `mandatory:true, dueAt:"2026-05-25"`. **Esperado:**
- Notif de atribuição vem com título "Trilha obrigatória..." + body "concluir até DD/MM/AAAA"
- `GET /tracks-admin/<slug>/adherence` retorna `total`, `completed`, `overdue`, `users[]`
- Forçar scheduler manual: `node -e "import('./scheduler/academyDeadlineScheduler.js').then(m => m.runDeadlineCheck())"` — dispara D-X em users pendentes

## 15. S2.1 — Module hierarchy

Admin: `POST /tracks-admin/<slug>/modules` cria módulo. `PATCH /tracks-admin/<slug>/items/<itemId>/move` com `{moduleId: 5}` move item. `GET /tracks/<slug>` retorna `modules[].items[]`.

## 16. S2.2 — Banco de questões

```bash
# Cria pergunta
curl -X POST -H "Authorization: Bearer <TOKEN_A>" -H "Content-Type: application/json" \
  -d '{"text":"2+2?","type":"SINGLE","options":["3","4","5"],"correctIndexes":[1]}' \
  "http://localhost:3000/api/academy/admin/questions"

# Liga à um quiz item
curl -X POST -H "Authorization: Bearer <TOKEN_A>" -H "Content-Type: application/json" \
  -d '{"questionId":<id>}' \
  "http://localhost:3000/api/academy/admin/quiz-items/<itemId>/questions"
```
Como U: `GET /academy/tracks/<slug>` → item QUIZ agora tem `payload.quiz.questions` com a pergunta SEM correctIndexes. Submit funciona normal.

## 17. S2.3 — Tentativas múltiplas + nota mínima

Admin edita item QUIZ com `payload.rules = { passingScore: 70, maxAttempts: 3, cooldownMinutes: 1 }`.

U tenta:
1. Erra 100%: response `passed:false`, `scorePercent:0`, `attemptNumber:1`, `attemptsRemaining:2`
2. Imediatamente tenta de novo: **429** com `cooldownRemainingMin:1`
3. Espera 1 min, acerta 70%: `passed:true`, `scorePercent:70`, `attemptNumber:2`
4. Tenta de novo: **409** "Você já foi aprovado"

Banco:
```sql
SELECT user_id, item_id, attempt_number, score_percent, all_correct FROM academy_user_quiz_attempts WHERE user_id=<id> ORDER BY attempt_number;
```

## 18. S2.4 — Versionamento KB

Admin edita um artigo `body="Versão A"` → `body="Versão B"`. Conferir:
- `GET /academy/kb/articles/<id>/versions` retorna 1 versão (versionNumber:1, body:"Versão A")
- `POST /academy/kb/articles/<id>/versions/1/restore` → artigo volta a "Versão A", e cria versão 2 com "Versão B" (auto-snapshot)
- Outra edição sem mudança no body NÃO cria nova versão (versionamento só dispara em mudança material)

## ✅ Checklist final

### Fase 1 (estabilização)
- [ ] Scripts SQL aplicados sem erro
- [ ] Backend sobe sem reclamar de duplicata em sync
- [ ] KB drafts protegidos (item 3)
- [ ] Quiz não vaza correctIndex (item 4.2)
- [ ] Smoke test do quiz 4/4 OK (item 4.3)
- [ ] Upsert idempotente em progress (item 5)
- [ ] Ranking paginado com `rank` contínuo (item 6)
- [ ] Reorder valida completude (item 7)
- [ ] Highlights CRUD funcional só para admin (item 8)
- [ ] Upvote idempotente + bloqueia voto próprio (item 9)
- [ ] 4 tipos de notificação Academy disparando (item 10)
- [ ] Admin marca progresso em trilha BOTH sem erro (item 11)

### S1 (compliance base)
- [ ] Certificado emitido na conclusão + PDF + verificação pública (item 12)
- [ ] Audience derivado server-side ignora query (item 13)
- [ ] Trilha mandatory com dueAt dispara lembretes (item 14)

### S2 (estrutura pedagógica)
- [ ] Modules + move item funcional (item 15)
- [ ] Banco de questões integrado ao quiz (item 16)
- [ ] passingScore + maxAttempts + cooldown funcionais (item 17)
- [ ] Versionamento de artigo snapshot + restore (item 18)
