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
3. **Escopo de dados SEMPRE via `services/permissions/accessScopeService.js`**
   (`getScope`/`visibleCvIds`/`visibleErpIds`/`visibleCities`/`isErpAllowed`).
   NUNCA filtrar por `user.city` ou `COALESCE(city_override, default_city)` na
   mão. Fail-closed: lista vazia → resultado vazio; `null` → admin sem filtro.
4. **Alçadas de tela**: rotas efetivas = (perfil vivo ∪ routes_extra) −
   routes_removed, calculadas por `services/permissions/permissionAccessService.js`.
   Não ler `user_permissions.routes` direto (coluna legada).
5. **Tools novas da Eme**: SEMPRE via `registerTool` (ToolRegistry) com
   `requiredPermissions`/`adminOnly` declarados — nunca no mapa legado do
   OfficeChatService. Filtros de segurança DENTRO do handler com base em
   `user` + accessScopeService; args do Gemini nunca ampliam escopo.
6. **Depois de qualquer mudança**: rodar o validador (tela `/settings/integrity`
   ou `POST /api/admin/integrity-check`). FAIL = corrigir antes de commitar.
   Um resumo roda sozinho ~30s após o boot (log `[Integrity]`).

## Entidades do modelo de acesso

- `companies` / `enterprises` (registro unificado CV×Sienge) — populados por
  `services/org/enterpriseRegistryService.js` (tela /settings/empresas).
- `enterprise_grants` — liberação por empreendimento (subject user|profile).
- `users.permission_profile_id` — perfil VIVO (editar propaga).
- Flag `ACCESS_MODEL` (env): `enterprise` (default, grants) | `city` (rollback
  legado por cidade).

## Convenções

- Renomeou rota de tela no front? Adicionar em `lib/ensurePermissionRouteRenames.js`.
- Cidade/cargo de usuário: usar as FKs `users.position_id`/`users.city_id`
  (strings `position`/`city` são legado mantido por compat).
- Commits: Conventional Commits pt-BR, SEMPRE por lista explícita de arquivos
  (nunca `git add -A` — working tree compartilhado via OneDrive).
- Sem em-dash em textos; usar hífen.
