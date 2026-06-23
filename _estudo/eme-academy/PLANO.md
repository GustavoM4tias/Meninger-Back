# Eme × Processos do Academy — plano de desenvolvimento

Objetivo: a Eme (assistente do Office) atua sobre os **procedimentos/processos** do Academy —
responde perguntas, **indica quais processos são necessários para uma ação**, sugere processos e
**resume** processos existentes. Com **economia de tokens** para não forçar a chave Gemini.

Aterrado na arquitetura real (`services/OfficeAI/OfficeChatService.js`): Gemini com pools
flash/pro + rotação de chave; function calling; `summarizeForGemini` (corta arrays); trava
anti-alucinação no Academy (`functionCallingConfig: mode ANY`). `AcademyTools` já filtra por
audience + **departamento**.

## Estratégia de economia (núcleo)
Tirar o custo do caminho por-pergunta e jogar para o por-artigo (1× na publicação):
- **Digest** por artigo (Flash, 1×): `{resumo, processFor[], prerequisites[], department, triggers[], systems[]}`.
- **Embedding** por artigo (`text-embedding-004`, 768d): busca semântica sem token de LLM.
- **Busca vetorial** (pgvector) → 0 token de LLM. Híbrida com o `iLike` atual.
- **Digest-first**: a maioria das perguntas é respondida só com digests (~100-150 tok cada).
- **Corpo sob demanda / por seção**: só quando precisa de passo-a-passo. Truncado.
- **Cache**: FAQ (query→resposta) + (futuro) context cache do prompt estável.
- **Guardrails**: máx. K digests, máx. 1-2 corpos/turno, teto por usuário, regeneração só se `digest_hash` mudou.

## Fases (todas autorizadas — 2026-06-21) — IMPLEMENTADAS (build/syntax OK)
- [x] **F0 — ler conteúdo:** `academy_get_process(slug, section?)` + `kb_search` agora devolve digests.
  **Academy tools plugadas no OFFICE** (OfficeChatService: `getToolsFor('OFFICE')` + roteamento
  `findTool→SecureRunner` em qualquer contexto).
- [x] **F1 — digests:** `academyDigestService` (Flash + hash sha256), colunas `ai_digest`/`process_meta`/
  `digest_hash`; hook no `kbAdminService.publish` (async); `scripts/academy_backfill_digests.js`.
- [x] **F2 — semântica:** coluna `embedding vector(768)` + índice hnsw; `academyRetrievalService` híbrido
  (vetorial pgvector + keyword). Degrada p/ keyword sem pgvector.
- [x] **F3 — grafo + requisitos:** `academy_process_requirements(acao)`; grafo via AI-extraction
  (processFor/prerequisites no digest) + reuso de cross-links. ⚠️ FALTA (curadoria opcional): campos
  `processMeta` no EDITOR p/ o autor sobrescrever a extração da IA (o read-path em `_toDigestResult`
  já prioriza `process_meta` sobre `ai_digest`; só falta a UI/escrita).
- [x] **F4 — economia:** cache de embedding-de-query (30min) + resultado-de-busca por usuário (10min);
  tetos (k=6 digests, corpo truncado 6k, regenera só se `digest_hash` muda); digest-first.

⚠️ summarizeForGemini do chat REMOVE arrays do tool result → as tools entregam os digests como
TEXTO (campo `processos`), não array, para o modelo ler. Lição registrada.

## Arquivos
- Backend: `lib/ensureAcademySchema.js` (colunas+pgvector), `models/sequelize/academy/article.js`,
  `services/OfficeAI/geminiClient.js` (novo — client compartilhado embed/json),
  `services/academy/academyDigestService.js` (novo), `services/academy/academyRetrievalService.js` (novo),
  `services/OfficeAI/AcademyTools.js` (tools novas), `services/OfficeAI/OfficeChatService.js` (wiring Office),
  `services/academy/kbAdminService.js` (hook publish), `scripts/academy_backfill_digests.js` (novo).
- Front: editor de artigo (campos `processFor`/`prerequisites` — F3).

## Operação (o usuário roda)
1. **Reiniciar backend** → `ensureAcademyPreSync` cria colunas + tenta `CREATE EXTENSION vector`
   (se a extensão não existir no Railway, degrada para busca por keyword — F0/F1 funcionam mesmo assim).
2. **Backfill**: `node scripts/academy_backfill_digests.js` (gera digests+embeddings dos artigos
   publicados; custo Flash amortizado; idempotente por `digest_hash`).
3. `GEMINI_API_KEYS` já configurada (rotação). Embedding usa a mesma chave.

## Decisões registradas
- pgvector: tentar habilitar; **degradar para keyword** se faltar (não bloqueia).
- Grafo: bootstrap por **AI-extraction** (no digest) + **cross-links** existentes; campos no editor evoluem.
- Tiering: digest/embedding = Flash; resposta = pool atual (Academy força pro; Office heurística).
