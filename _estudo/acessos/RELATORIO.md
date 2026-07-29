# Relatório - Refatoração de Acessos (concluída em 2026-07-29)

Todas as fases da spec (F1-F5) foram implementadas e estão no main dos dois
repositórios. Este documento resume o que mudou e como usar o sistema novo.

## Commits

Back: `2c2dc78` (blindagem fase 0), `db27819` (remoção de Categorias),
`2254265` (fundação: registro unificado, grants, perfil vivo),
`63e8009` (enforcement, escopo por empreendimento, validador).
Front: `95cf0ab` (guard), `7ddcbbd` (Categorias), `0bde41d` (telas novas).

## O que mudou

### 1. Segurança passou do front para o servidor
Antes, a alçada era só visual (menu escondido); a API entregava dados a
qualquer autenticado. Agora:
- `requireRoutePermission(['/tela'])` em toda rota de dados: sem a tela
  liberada nas Alçadas, a API responde 403 - inclusive para a Eme.
- `requireAdmin` em todos os gatilhos/telas admin (syncs, backups, boletos,
  cancelamentos, drop de tabelas), e 9 endpoints que estavam SEM autenticação
  foram fechados.
- Guard do front honra admin e não confia mais em localStorage.

### 2. Acesso a dados por EMPREENDIMENTO (não mais por cidade)
- Registro unificado: tabelas `companies` (empresas Sienge) e `enterprises`
  (empreendimento CV×Sienge pareado), consolidadas dos syncs. SEM override
  manual de cidade - o dado é o efetivo das fontes.
- `enterprise_grants`: liberação explícita por empreendimento, para usuário
  ou para perfil. Atalhos por empresa/cidade na tela apenas EXPANDEM para
  ids (empreendimento novo nunca entra sozinho).
- `accessScopeService` é a fonte única do escopo em ~20 controllers/services
  e em todas as tools da Eme. Fail-closed: sem grant → sem dado.
- Flag `ACCESS_MODEL` (env): `enterprise` (default) | `city` (rollback de
  emergência para o comportamento antigo por cidade).

### 3. Alçadas de tela: perfil VIVO + exceções
- O usuário aponta para um perfil (`users.permission_profile_id`); editar o
  perfil muda o acesso de todos os vinculados na hora.
- Exceções por usuário: telas extras e telas negadas
  (`user_permissions.routes_extra`/`routes_removed`).
- Efetivas = (perfil ∪ extras) − negadas. As alçadas antigas foram copiadas
  para `routes_extra` no primeiro boot - ninguém perdeu acesso de TELA.
- Ativação de usuário novo aplica o perfil do departamento POR REFERÊNCIA.

### 4. Departamentos, cargos e vínculos estruturados
- Seed idempotente: 15 departamentos padrão de construtora e 23 cargos com
  nível hierárquico (0 Sócio Fundador … 8 Estagiário). Cadastros existentes
  intocados; descrições vazias completadas.
- `users.position_id`/`users.city_id` (FK reais) com backfill por nome;
  não-casados aparecem no log de boot e no validador. Renomear cargo/cidade
  não quebra mais vínculo.

### 5. Categorias e Vínculos de cidades
- Cadastro de Categorias removido (histórico preservado em
  expense_personalizations.department_category_name).
- Tela "Vínculos de cidades" substituída por "Sincronização de empresas"
  (/settings/empresas, rota antiga redireciona).

### 6. Validador de integridade
- `security/integrityCheck.js`: varre TODAS as rotas do Express (auth,
  admin, alçada), as tools da Eme (permissão declarada, mapa legado) e o
  banco (tabelas, FKs de usuário, grants órfãos, perfis inativos, cobertura
  de escopo). Exceções legítimas vivem em allowlist comentada.
- Roda pela tela /settings/integrity, por POST /api/admin/integrity-check e
  automaticamente ~30s após cada boot (resumo no log `[Integrity]`).

## MÉTODO DE USO (dia a dia do admin)

1. **Sincronizar empresas** - Settings > Empresas: rode "Sync CV" e "Sync
   Sienge" (confirmação em 2 passos). Confira o status de pareamento; linhas
   "Só CV"/"Só Sienge" que são o mesmo empreendimento → botão Parear.
   Empreendimento sem empresa → botão Empresa.
2. **Liberar acessos** - Settings > Alçadas:
   - Aba Perfis: monte/ajuste os perfis (telas + botão "Empreend." para os
     empreendimentos padrão do perfil). Tudo propaga na hora.
   - Aba Usuários: selecione a pessoa → escolha o Perfil → ajuste exceções
     de tela (switch por página; badge mostra perfil/extra/negada) → botão
     "Empreendimentos liberados" para os dados (atalhos por empresa e por
     cidade) → Salvar.
   - Clonar: ícone de copiar na lista + "Colar", ou aplique o mesmo perfil.
3. **IMPORTANTE - estado pós-cutover**: os acessos de DADOS começaram
   ZERADOS (decisão de projeto). Todo não-admin continua vendo as telas que
   já tinha, mas os dados vêm vazios até você liberar os empreendimentos
   (por perfil ou por usuário). Admins veem tudo.
4. **Validar** - Settings > Integridade > "Rodar validação". Zero FALHA =
   sistema íntegro. Rodar após qualquer funcionalidade nova (ou pedir ao
   agente: "rode o validador de integridade").
5. **Funcionalidade nova** - seguir o CLAUDE.md do Back (padrão obrigatório:
   authenticate + requireRoutePermission + accessScopeService + tool via
   ToolRegistry). O validador acusa o que nascer fora do padrão.

## Rollback de emergência

- Dados por cidade (comportamento antigo): setar env `ACCESS_MODEL=city` e
  reiniciar o backend. As alçadas de tela novas continuam valendo.

## Pendências conhecidas (não bloqueantes)

- `POST /api/ai/validator` é chamado server-to-server sem usuário (job de
  análise de contratos) - está na allowlist; ideal futuro: shared secret.
- `GET /api/admin/enterprise-cities` segue leitura autenticada (Títulos/
  Custos usam para rótulos); migrar esses consumidores para /api/admin/org e
  então restringir.
- Alertas da Eme re-executam tools com o escopo do dono do alerta (se o dono
  perder grants, o alerta passa a vir vazio - comportamento correto, mas
  vale comunicar).
- `enterprise_cities` permanece como fonte do modo city e de resolução de
  nomes; aposentadoria total fica para quando o modo city for removido.
