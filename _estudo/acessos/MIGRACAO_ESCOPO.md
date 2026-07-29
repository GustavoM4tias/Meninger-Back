# Padrão de migração: filtro por cidade → accessScopeService

Este documento define O ÚNICO padrão aceito para filtrar dados por usuário.
Toda funcionalidade nova nasce assim; todo código legado com filtro por cidade
migra para cá. O validador de integridade cobra este padrão.

## O serviço

`services/permissions/accessScopeService.js`:

```js
import { getScope, visibleCvIds, visibleErpIds, visibleCities, isErpAllowed }
  from '../services/permissions/accessScopeService.js';

const scope = await getScope(req.user);
// scope.all === true  → admin, NÃO filtrar nada
// scope.cvIds         → ids de empreendimento CV visíveis
// scope.erpIds        → ids de centro de custo Sienge visíveis
// scope.cities        → cidades dos empreendimentos visíveis (uso restrito)
```

A flag `ACCESS_MODEL` (env) decide internamente:
- `city` — modo legado: o serviço RESOLVE os ids a partir da cidade do usuário
  (mesma query normalizada de antes). Comportamento idêntico ao histórico.
- `enterprise` (default) — grants por empreendimento (enterprise_grants:
  usuário + perfil vivo).

Os CONSUMIDORES nunca mais olham `user.city` nem fazem `COALESCE(city_override,
default_city)` — só usam listas de ids.

## Regras de reescrita

1. **Fail-closed**: não-admin com lista vazia recebe resultado VAZIO (não erro
   500, não dados). Igual ao antigo "sem cidade → vazio".
2. Onde o SQL fazia `JOIN enterprise_cities ... AND norm(effective_city) = norm(:city)`,
   trocar por filtro de id na PRÓPRIA tabela de dados:
   - dados CV (reservas, precadastros, leads, fichas): `idempreendimento IN (:cvIds)`
     (ou o campo equivalente da tabela).
   - dados Sienge (bills, contratos, custos): centro de custo/CC
     `IN (:erpIds)` — para CC use `isErpAllowed` quando validar UM id (cobre
     sub-CC 80104 → base 80001).
3. Onde o controller já resolvia "ids visíveis por cidade" (ex.
   getVisibleEnterpriseIds), substituir a implementação por
   `visibleCvIds(req.user)` mantendo a assinatura.
4. `null` retornado por visibleCvIds/visibleErpIds/visibleCities = admin = sem
   filtro. `[]` = filtra tudo (WHERE FALSE).
5. Eventos (filtro por endereço) e casos sem id de empreendimento: usar
   `visibleCities(user)` — no modo enterprise são as cidades dos
   empreendimentos liberados.
6. Tools da Eme: `effectiveCity = isAdmin ? args.cidade : user.city` vira
   `const cvIds = await visibleCvIds(user)` (args do Gemini continuam sendo
   apenas hints de filtro ADICIONAL, nunca ampliam o escopo).
7. NÃO apagar `lib/cityResolver.js`/`enterprise_cities` — seguem como fonte do
   modo city dentro do accessScopeService e para resolução de nomes.

## Exemplo antes/depois

Antes (controllers/cv/reservas.js):
```js
const ids = await getVisibleEnterpriseIds(req.user.city); // SQL por cidade
if (!ids.length) return res.json([]);
where += ` AND r.idempreendimento IN (:ids)`;
```

Depois:
```js
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';
const ids = await visibleCvIds(req.user); // null = admin
if (ids && !ids.length) return res.json([]);
if (ids) where += ` AND r.idempreendimento IN (:ids)`;
```

## Consumidores a migrar (mapa 2026-07-28)

- controllers/cv/reservas.js (getVisibleEnterpriseIds), empreendimentosDb.js
  (cache por cidade → cache por hash do escopo), precadastros.js,
  reservasReport.js, leads.js
- controllers/sienge/billsController.js (validação por CC → isErpAllowed),
  cefConsultaController.js (resolveScope), contractSalesController.js,
  paymentFlowController.js, enterpriseResolverController.js
- controllers/comercial/enterpriseConditionController.js (linha ~309)
- controllers/projectionController.js (SQL_ALLOWED + usos; remover a
  interpolação manual de userCity na linha ~1491)
- controllers/eventController.js (visibleCities)
- services/cv/workflowGroupQueriesService.js,
  services/realestate/realEstateReportService.js
- services/expenseService.js summarizeAllMonth (Custos NÃO filtrava — passar a
  filtrar costCenterId por erpIds)
- controllers/deptSpendingController.js (Viabilidade NÃO filtrava — filtrar
  empreendimentos por erpIds/companyIds)
- validatorAI/src/routes/historyRoutes.js
- services/OfficeAI/: OfficeChatService.loadAccessibleEnterprises,
  ComercialTools, MarketingTools, ProjectionTools, ConditionTools
