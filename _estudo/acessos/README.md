# Refatoração de Acessos - Empresas, Alçadas e Validador de Integridade

Data: 2026-07-28. Decisões fechadas com o Gustavo nesta data.

## Decisões fechadas

1. **Granularidade**: a unidade de liberação é o EMPREENDIMENTO (centro de custo
   unificado CV+Sienge). A tela oferece atalhos para marcar todos os
   empreendimentos de uma empresa ou de uma cidade de uma vez.
2. **Migração**: ZERAR - no cutover, todo usuário não-admin começa sem acesso a
   dados de empreendimento até liberação manual pela tela de Alçadas.
   Nenhuma conversão automática de cidade para grants.
3. **Modelo de alçada de rotas**: perfil VIVO + exceções. O usuário aponta para
   um perfil; editar o perfil propaga na hora para todos os vinculados.
   Exceções individuais (adicionar/remover rota) por cima do perfil.
   "Clonar" vira "aplicar o mesmo perfil".
4. **Fase 0 (blindagem)**: CONCLUÍDA em 2026-07-28 (commits `2c2dc78` no Back e
   `95cf0ab` no Front). Endpoints sem auth fechados, requireAdmin nos syncs e
   no override de cidade, guard do front honra adminOnly sem localStorage,
   tools legadas da Eme com alçada e audit real.
5. **Categorias**: cadastro removido em 2026-07-28 (`db27819` Back / `7ddcbbd`
   Front). Histórico preservado em expense_personalizations.department_category_name.

## Estado atual (mapeado em 2026-07-28)

- Alçada de rotas: user_permissions.routes (JSON por usuário), SEM enforcement
  no backend até a fase 0; permission_profiles é template aplicado uma vez na
  ativação (não propaga).
- Filtro de dados: users.city (string livre) × enterprise_cities.effective_city
  (COALESCE(city_override, default_city)) em ~25 arquivos de SQL cru.
- Não existe entidade "empresa": derivada de enterprise_cities.raw_payload
  (idCompany/companyName) e contracts.company_id/company_name.
- Pareamento CV↔Sienge: cascata manual (enterprise_erp_links) → etapa_reserva →
  etapa_cadastro → empreendimento → cadastro_cv, duplicada em
  enterpriseErpLinkController e workflowGroupQueriesService.
- users.position e users.city são STRINGS por nome (sem FK) - renomear cargo ou
  cidade quebra login/visibilidade em silêncio.

## Modelo de dados alvo

### `companies` (empresa Sienge)
- `id` (= company_id do Sienge), `name`, `cnpj?`, `active`, `last_seen_at`.
- Fonte: sync Sienge (cost centers trazem idCompany/companyName no payload;
  contracts.company_id complementa).

### `enterprises` (empreendimento unificado - substitui o papel do enterprise_cities)
- `id` PK interno.
- `cv_id` (idempreendimento CV, nullable), `erp_cost_center_id` (nullable),
  `company_id` FK → companies (nullable até parear).
- `name`, `city`, `uf` (efetivos, vindos das fontes - SEM override manual).
- `pair_status`: paired | cv_only | erp_only (visível na tela de sincronização).
- `cv_payload`/`erp_payload` JSONB, `active`, `first_seen_at`, `last_seen_at`.
- A cascata de resolução ERP (manual → etapa → empreendimento → cadastro) passa
  a ser resolvida AQUI no sync e gravada, não recalculada em cada query.
  enterprise_erp_links continua como fonte do pareamento manual, gerenciado na
  mesma tela.
- Transição: enterprise_cities NÃO é dropada de imediato; vira leitura legada
  até todos os consumidores migrarem para o accessScopeService. city_override
  deixa de ser editável já na primeira entrega (tela nova sem override).

### Grants de acesso
- `enterprise_grants`: (subject_type: 'user' | 'profile', subject_id,
  enterprise_id, granted_by, created_at). Único por (subject_type, subject_id,
  enterprise_id).
- Atalhos "empresa inteira"/"cidade inteira" são AÇÕES de UI que expandem para
  linhas por empreendimento (autoexplicável, auditável, sem regra implícita).
  Empreendimento novo de uma empresa NÃO entra sozinho em grants existentes
  (decisão de segurança: liberação sempre explícita).

### Perfil vivo + exceções (rotas)
- `users.permission_profile_id` FK → permission_profiles (nullable).
- `user_permissions` passa a guardar EXCEÇÕES: `routes_extra` (JSON) e
  `routes_removed` (JSON). Rotas efetivas = (profile.routes ∪ routes_extra) −
  routes_removed. Compat: `routes` atual é migrado para `routes_extra` no boot
  (patch idempotente) para ninguém perder alçada de TELA (dados de
  empreendimento continuam zerados até grants).
- permission_profiles ganha grants de empreendimento padrão via
  enterprise_grants (subject_type='profile') - liberar no perfil propaga.

## accessScopeService (o coração)

`services/permissions/accessScopeService.js`:
- `getScope(user)` → `{ all: boolean, enterpriseIds: number[], companyIds,
  cvIds, erpCostCenterIds, cities }` (admin → all:true). Cacheado por request.
- `assertRoute(user, route)` → rotas efetivas do perfil+exceções (substitui a
  ausência de enforcement; middleware `requireRoutePermission('/rota')`).
- Helpers SQL: `scopeWhere(alias)` para IN (...) nos ~25 pontos que hoje fazem
  match por cidade normalizada.
- Consumidores: todos os controllers de dados (cv/*, sienge/*, comercial/*,
  projeções, custos, viabilidade, eventos, leads) e TODAS as tools da Eme
  (SecureRunner passa a injetar o scope; tools legadas já checam alçada de
  rota desde a fase 0).
- Regra de ouro (documentar no CLAUDE.md do Back): funcionalidade nova NUNCA
  filtra por cidade/empresa na mão; sempre via accessScopeService. O validador
  cobra isso.

## Telas

### /settings/cidades → "Sincronização de empresas"
- Lista unificada (sem duplicata CRM×ERP): nome, empresa, cidade/UF, CV id,
  CC Sienge, pair_status, last_seen.
- Ações: Sync CV, Sync Sienge (admin, com confirmação), parear manualmente
  (grava enterprise_erp_links), inativar.
- SEM override de cidade. Campo cidade é o efetivo das fontes.

### /settings/permissions (Alçadas) - reformulada
- Aba Usuários: perfil aplicado (select), exceções de rota (chips add/remove),
  empresas/empreendimentos liberados (árvore Empresa → Empreendimentos com
  checkbox, atalhos por cidade), botão "aplicar perfil de outro usuário".
- Aba Perfis: rotas do perfil + grants padrão de empreendimento; editar
  propaga na hora (perfil vivo).
- Aba Departamentos: mantida (visibilidade de departamentos de custo).

## Departamentos e cargos padrão (seed idempotente)

Departamentos (manter existentes, criar os que faltarem, melhorar descrições):
Administrativo, Comercial, Diretoria, Financeiro, Marketing, Novos Negócios,
Legalização, Sócio Fundador, Engenharia/Obras, Suprimentos, RH/DP, TI,
Jurídico, Assistência Técnica (Pós-obra), Contabilidade.

Cargos com hierarquia (campo `level` int em positions p/ ordenação de
organograma): Diretor(1), Gerente(2), Coordenador(3), Supervisor(4),
Analista(5), Assistente(6), Auxiliar(7), Estagiário(8) + específicos
(Corretor, Gestor Comercial etc. mantidos).

FKs reais (patch + backfill por nome, com log de não-casados):
- `users.position_id` FK → positions (mantém users.position string até o fim
  da transição; login passa a validar pelo id).
- `users.city_id` FK → user_cities (cidade vira só metadado de pessoa, não
  mais chave de acesso).

## Validador de integridade

`security/integrityCheck.js` no Back + rota `POST /api/admin/integrity-check`
(admin) + tela `/settings/integrity` com botão "Rodar validação".

Checks (cada um com status ok/warn/fail e detalhe):
1. Varre o app Express (router stack): toda rota /api/* tem authenticate;
   lista as exceções permitidas (allowlist explícita: login, webhooks
   assinados, rotas públicas do bolão/lp).
2. Rotas admin (naming ou allowlist) têm requireAdmin.
3. Rotas de dados têm requireRoutePermission ou constam da allowlist.
4. Toda tool da Eme registrada tem requiredPermissions/adminOnly declarado;
   nenhuma tool fora do ToolRegistry (mapa legado precisa estar vazio ao fim
   da migração).
5. Amostras de escopo: usuário sintético sem grants não recebe linhas de
   /api/expenses, /api/sienge/bills, /api/conditions, etc. (smoke com
   supertest, sem tocar produção).
6. Schema: FKs esperadas existem; users sem position_id/city_id casados;
   perfis com rotas mortas (não presentes no navRegistry exportado).
7. Front (estático): rota gerenciada nova no navRegistry sem entrada de
   alçada correspondente.
Saída: JSON + resumo humano; exit code != 0 se houver fail (usável em CI).

## Ordem de implementação (tudo ADITIVO até o cutover)

1. **F1 - Fundação**: tabelas companies/enterprises/enterprise_grants +
   colunas de perfil/exceção + syncs populando as tabelas novas (sem tocar
   consumidores). Tela Sincronização de empresas lendo do novo modelo.
2. **F2 - Alçadas**: perfil vivo + exceções + tela nova + middleware
   requireRoutePermission aplicado nas rotas de dados (alçada de TELA já
   enforced; dados ainda por cidade).
3. **F3 - Escopo**: accessScopeService + migração dos ~25 pontos + tools da
   Eme. Flag `ACCESS_MODEL=city|enterprise` (default city) para validar em
   paralelo sem cortar ninguém.
4. **F4 - Cutover**: virar ACCESS_MODEL=enterprise (zerar), acompanhar,
   remover código de cidade + enterprise_cities legada + flag.
5. **F5 - Validador** (pode andar em paralelo desde F2) + seeds de
   departamentos/cargos + FKs de users (independentes, entram cedo).

## Riscos/atenções

- Deploy no main é contínuo: cada fase precisa ser inofensiva até o cutover
  (F4 é o único commit que muda o que usuários veem).
- Sessões concorrentes no mesmo working tree (OneDrive): commitar SEMPRE por
  lista explícita de arquivos, nunca `git add -A`.
- Alert re-execução (AlertReportService) usa as tools com o user dono do
  alerta: após F3, o scope do dono vale para o alerta (documentar na tela).
- ensurePermissionRouteRenames deve migrar TAMBÉM permission_profiles.routes
  (bug M9 do mapeamento) - entra na F2.
