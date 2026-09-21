# ValidatorAI - API de validação de contratos

Compara o **Contrato Caixa** (financiamento MCMV pela CEF) com a **Confissão de
Dívida** da construtora e aponta divergência de pessoas, valores, datas e
assinaturas. Monta o `app` Express que o backend monta em `/api/ai`
(`server.js`); não sobe sozinho.

## Quem chama

Duas portas, e nenhuma pode barrar a outra (o portão está em `index.js`):

1. **O job de análise automática**, server-to-server, sem usuário no fluxo.
   Entra pelo token interno (`security/internalJobToken.js`). Quem dispara é o
   webhook `CONTRATOS_IA` do CV, quando o repasse entra em "Analise Contratos"
   (`services/contractAnalysisService.js`).
2. **A tela `/validator`**, onde alguém sobe os dois PDFs na mão. Entra pelo JWT
   do usuário, com a alçada da rota.

## Modelos

**A lista de modelos NÃO mora mais em `GEMINI_MODELS`.** Ela mora em
`validator_settings.models` e é editada na tela `/validator` > aba **Saúde**,
que também mostra qual modelo respondeu e qual devolveu 404.

O motivo é o dia em que o provedor aposenta um modelo: com a lista presa na
variável de ambiente, toda análise passava a responder 404 e o conserto dependia
de quem tem acesso ao painel de deploy. A env continua como **piso** - vale
enquanto a linha não existe (primeiro boot) e quando o banco não responde.

`AIService` tenta os modelos na ordem e trata as falhas de forma diferente,
porque elas pedem remédios diferentes: **429** é a chave que estourou (esfria
ela e vai para a próxima), **5xx** é o modelo sobrecarregado (repete na mesma
chave, esperando mais a cada rodada), **404** é o modelo que não existe (pula
para o próximo e aparece na aba Saúde).

## Saúde

`AIService.ping(model)` toca em UM modelo, sem fallback, e é o que a sonda
(`services/validator/validatorHealthService.js`, agendada por
`scheduler/validatorHealthScheduler.js`) usa para responder "daria para validar
agora?" sem depender de haver contrato na fila. `GET /validator/health` é a
prova de vida desta API, batida pelo mesmo cliente axios que a análise usa -
assim a sonda testa a `VALIDATOR_API_BASE_URL` de verdade.

Quando a sonda encontra problema, sai aviso (sino + e-mail) para os
destinatários escolhidos na tela, ou para todos os administradores quando
ninguém foi escolhido. E sai outro quando volta ao normal.

## Variáveis de ambiente

| Variável | Para quê |
| --- | --- |
| `GEMINI_API_KEYS` | Chaves do Gemini, separadas por vírgula. Rotação round-robin com cooldown por chave. Ausente = a API não carrega. |
| `GEMINI_MODELS` | **Piso** do pool de modelos. Quem manda é `validator_settings.models`. |
| `GEMINI_MAX_RETRIES` | Mínimo de tentativas por modelo (padrão 3). |
| `VALIDATOR_API_BASE_URL` | Onde o job encontra esta API (padrão `http://localhost:5000/api/ai`). |
| `VALIDATOR_TIMEOUT_MS` | Teto de uma análise (padrão 300000). |
| `CONFISSAO_REGRAS` | Texto do procedimento interno, quando não se quer o prompt embutido. |
| `ENABLE_VALIDATOR_HEALTH` | Liga a sonda fora de produção (em produção ela sobe sozinha). |

## Rotas

| Rota | Portão | O que faz |
| --- | --- | --- |
| `POST /validator` | token interno **ou** alçada `/validator` | Valida o par de PDFs. |
| `GET /validator/health` | idem | Prova de vida (não devolve dado). |
| `GET /validator/history` | alçada `/validator` | Histórico de validações. |
| `POST /chat` | alçada `/validator` | Pergunta livre sobre documento. |
| `GET /token` | alçada `/validator` | Consumo de tokens (total e por mês/modelo). |
| `POST /payment-flow` | autenticado | Extração de dados de pagamento. |

## Estrutura

```
validatorAI/
├── index.js                     app Express + portões de acesso
└── src/
    ├── config/geminiClient.js   chaves, rotação e cooldown
    ├── services/
    │   ├── AIService.js         tentativas, fallback, ping e contagem de tokens
    │   ├── DocumentValidator.js o prompt e a comparação dos dois contratos
    │   ├── PaymentExtractorService.js
    │   ├── MeetingSummaryService.js
    │   └── ChatService.js
    ├── routes/                  document, history, chat, stats, payment-flow
    ├── middleware/              validation, errorHandler
    └── utils/db.js              acesso ao Sequelize do backend
```

## Consumo de tokens

Toda chamada bem-sucedida grava uma linha em `token_usages` com o modelo, o
total de tokens (do `usageMetadata` do provedor, não estimado) e o índice da
chave usada. `GET /token/total` e `GET /token/mensal` somam isso.
