# Meninger-Back

Backend Express + Sequelize (Postgres) do Menin Office. Boot: `npm run dev`
(nodemon). Schema via `sync({ alter })` + patches idempotentes `lib/ensure*.js`
registrados em server.js (NUNCA migration CLI, NUNCA script manual).

## PADRÃO DE SEGURANÇA (OBRIGATÓRIO em toda funcionalidade nova)

Spec completa: `_estudo/acessos/README.md` e `_estudo/acessos/MIGRACAO_ESCOPO.md`.

1. **Toda rota /api/* tem `authenticate`.** Exceção (webhook/pública) só com
   assinatura/token próprio E entrada comentada na allowlist de
   `security/integrityCheck.js`.
2. **Rota de tela admin → `requireAdmin`.** Rota de DADOS → `requireRoutePermission(['/rota-da-tela'])`
   (middleware que valida a alçada real no servidor; admin tem bypass).
2b. **Tela DELEGADA com ação sensível dentro → CAPACIDADES.** Declare as ações
   em `lib/screenCapabilities.js` (`'screen'` = tem a tela | `'admin'` = só
   admin), use `requireCapability('/rota', 'acao')` na API e `useCan('/rota')`
   na tela. NUNCA escreva `auth.hasRole('admin')` no componente: o front recebe
   as capacidades prontas do `/permissions/me` e só consulta, então UI e API não
   divergem. O validador cobra ação declarada sem enforcement.
2c. **Como escolher no front** (varredura de 2026-08-20 deixou zero exceções):
   tela delegável com ação de admin dentro → capacidade + `useCan`; tela 100%
   admin (ou livre com um detalhe de admin) → `permissionStore.isAdmin`, que é a
   fonte confirmada pelo servidor. NUNCA `authStore.user.role` e MUITO menos
   `localStorage.getItem('role')` — dava para se promover a admin no navegador.
3. **Escopo de dados SEMPRE via `services/permissions/accessScopeService.js`**
   (`getScope`/`visibleCvIds`/`visibleErpIds`/`visibleCities`/`isErpAllowed`).
   NUNCA filtrar por `user.city` na mão — o modo por cidade foi REMOVIDO
   (2026-07-29); acesso é só por grants. Fail-closed: lista vazia → resultado
   vazio; `null` → admin sem filtro. Nomes/cidades de empreendimento vêm da
   tabela `enterprises` (enterprise_cities foi dropada).
4. **Alçadas de tela**: rotas efetivas = (perfil vivo ∪ routes_extra) −
   routes_removed − telas travadas em `route_policies`, calculadas por
   `services/permissions/permissionAccessService.js`. Não ler
   `user_permissions.routes` direto (coluna legada).
4b. **Tela exclusiva de admin**: o padrão é o admin ligar o cadeado na tela
   `/settings/permissions` (grava `route_policies`; vale na hora para menu,
   guard, API e tools da Eme, sem deploy). Só use a trava de CÓDIGO
   (`adminOnly` no navRegistry + `requiresAdmin` no meta da rota + `requireAdmin`
   nas rotas de API) para administração do próprio sistema — nesse caso os TRÊS
   níveis são obrigatórios e o validador cobra.
5. **Tools novas da Eme**: SEMPRE via `registerTool` (ToolRegistry) com
   `requiredPermissions`/`adminOnly` declarados — nunca no mapa legado do
   OfficeChatService. Filtros de segurança DENTRO do handler com base em
   `user` + accessScopeService; args do Gemini nunca ampliam escopo.
6. **Depois de qualquer mudança**: rodar o validador (tela `/settings/integrity`
   ou `POST /api/admin/integrity-check`). FAIL = corrigir antes de commitar.
   Um resumo roda sozinho ~30s após o boot (log `[Integrity]`).

## Entidades do modelo de acesso

- `companies` / `enterprises` (registro unificado CV×Sienge) — populados por
  `services/org/enterpriseRegistryService.js` (sync direto das APIs; tela
  /settings/empresas + scheduler diário orgRegistryScheduler às 03:00).
- `enterprise_grants` — liberação por empreendimento (subject user|profile).
- `users.permission_profile_id` — perfil VIVO (editar propaga).
- `permission_profiles` — um perfil PADRÃO por departamento (`seed_code`),
  semeado por `lib/ensureSignupApprovalSchema.js`. O seed re-sincroniza as telas
  enquanto `routes_customized = false`; a primeira edição do admin congela o
  perfil (a tela oferece "Restaurar padrão" para devolvê-lo ao seed).
- `route_policies` — telas travadas como somente-admin pela tela de Alçadas.
- Rótulos p/ telas não-admin: GET /api/org/enterprise-labels (escopado).

## TUDO CONFIGURÁVEL (regra de produto, vale para toda feature nova)

Nada de solução bloqueada em código. Regra de negócio que a operação pode
querer mudar - prazo, teto, percentual, horário, situação do CV, destinatário,
texto - nasce em tabela de settings do módulo e com campo na tela. Constante em
código só serve como FALLBACK de quando não há valor configurado, nunca como a
regra em si.

- Valor novo: coluna em `<modulo>_settings` (+ `lib/ensure*.js`), entrada no
  `allowed` do controller de settings COM validação, e input na tela. Os três,
  sempre - config que existe no banco e não aparece na tela não existe.
- Override por recorte (empreendimento, cidade, departamento) quando fizer
  sentido: cascata `regra específica -> setting geral -> fallback do código`, e a
  mensagem de erro diz qual nível decidiu. Ver o `max_dias_vencimento` do Boleto.
- **O painel sempre ganha do código.** Mudar um default NÃO é mudar o valor de
  quem já configurou. Patch de dados que TROCA valor já gravado vai por
  `applyOnce` (`lib/schemaPatchMarks.js`), que roda uma vez só - repetido a cada
  boot, ele desfaria a escolha feita na tela. `UPDATE ... WHERE campo IS NULL`
  (preencher vazio) pode ficar nos ensure* normais.
- Gestão é sempre por tela: nada de script manual, nem de pedir "roda esse SQL".

## Convenções

- Renomeou rota de tela no front? Adicionar em `lib/ensurePermissionRouteRenames.js`.
- REMOVEU uma tela (ou decidiu que ninguém deve tê-la)? Adicionar em
  `lib/ensurePermissionRouteRetirement.js` E tirar da matriz de
  `lib/ensureSignupApprovalSchema.js` — só o primeiro faz a rota voltar no boot
  seguinte para todo perfil com `routes_customized = false`.
- Cidade/cargo de usuário: usar as FKs `users.position_id`/`users.city_id`
  (strings `position`/`city` são legado mantido por compat).
- Commits: Conventional Commits pt-BR, SEMPRE por lista explícita de arquivos
  (nunca `git add -A` — working tree compartilhado via OneDrive).
- Sem em-dash em textos; usar hífen.
