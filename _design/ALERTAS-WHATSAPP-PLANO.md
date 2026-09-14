# Alertas da Eme no WhatsApp - entrega de relatórios (plano)

Data: 14/09/2026. Pedido do Gustavo: "as mensagens de WhatsApp de alerta da Eme
estão quebrando, me mandando JSON inteiro ou texto de maneira ruim; quero
abordar o máximo que o WhatsApp possa oferecer para entregar meus relatórios,
talvez anexos".

Este documento é o PLANO. Quem executar segue as fases na ordem; cada fase
termina com um critério de pronto verificável. Vai para a atualização de
**01/10/2026** (entrada `v3.17.0` em `Meninger-Front/src/config/changelog.js`,
hoje com `date: null`; publicar = preencher a data).

## 0. Onde estamos (medido em 14/09/2026)

Fluxo de um alerta hoje (`services/alerts/`):

1. `AlertEngine.fire` executa a tool da regra via `AlertReportService.execute`.
2. `AlertReportService.buildReport` transforma o retorno da tool em texto
   WhatsApp; `buildPreview` gera a linha curta.
3. Sai o template `alert_generic_v2` (botões SIM/NÃO) com nome + título.
   O texto completo fica guardado em `alert_pending_replies.report_payload`.
4. A pessoa responde SIM → `AlertReplyHandler` manda `report_payload` por
   `sendText` (janela de 24h, grátis).

Por que quebra:

- **`buildReport` só conhece 4 formas** (`chart`, `table`, `detail` e
  "summary/kpis" solto). Desde `f1f4691` ("alertas com qualquer tool") a Eme
  pendura alerta em qualquer uma das 81 tools, e muitas devolvem outro
  `type`: `reservas_summary`, `precadastros_summary`, `repasses_summary`,
  `report_cards`, `checklist_cards`, `condition_compare`, `campaign_cards`,
  `meeting_card`... Nada casa e cai no fallback de
  `AlertReportService.js:299`: `JSON.stringify(result).slice(0, 800)` dentro
  de ``` ```. É o "JSON inteiro". `reservas_summary` (o alerta mais comum) não
  tem `summary`, `message`, `totals` nem `items`: cai direto no JSON.
- **Quando casa, é adivinhação de forma**: 1ª coluna vira título, mais duas
  viram "meta", 8 linhas, número sem tipo (moeda sai `1234567.89`, data sai
  ISO, chave crua tipo `total_vgv`), corte seco em 3.800 caracteres.
  `repasses_summary` tem `message` e sai SÓ a frase, sem os valores.
- **As tools já devolvem dado tipado e o alerta ignora.** Desde `9fa225a`
  as tools migradas devolvem `blocks` (contrato EmeBlock,
  `services/OfficeAI/blocks.js`): `dataset` com colunas
  `{ key, label, type: currency|percent|date|... }`, `kpis`, `cards`,
  `detail`. O chat lê isso; o alerta lê o formato antigo. Só 4 tools
  migraram (`query_desempenho_vendas`, `query_vendas_vs_projecao`,
  `correspondentes_search`, `query_condition_sheets`); o resto precisa de
  adaptador (o front tem `viz/legacyAdapter.js`, o back não).
- **O canal só usa texto.** `WhatsAppService` já tem `uploadMessageMedia`,
  `sendDocument`, `sendImage` e `sendTemplate` com header DOCUMENT (o boleto
  usa os três). Nada do alerta aproveita. Não existe `sendInteractive`
  (botões/lista livres).
- **O template inicial já é pago**; a resposta livre é grátis. Com header de
  documento, o PDF vai no MESMO template pago, sem depender de resposta.

## 1. O que o WhatsApp Cloud API oferece (o que vale usar)

| Recurso | Quando | Temos | Uso no alerta |
|---|---|---|---|
| Template com header DOCUMENT + botão URL | sempre (fora da janela) | sim | PDF na 1ª mensagem + "Abrir no Office" |
| Documento livre (PDF/XLSX/CSV, 100 MB) com legenda | janela 24h | sim | planilha completa, PDF sob demanda |
| Imagem (PNG 5 MB) com legenda | janela 24h | sim | gráfico como imagem (fase 4, opcional) |
| Texto formatado: `*`, `_`, `~`, ```` ``` ````, listas `- ` e `1. `, citação `> ` | janela 24h, 4.096 chars | só `*`/`_` | resumo legível |
| Interativo: botões (3), lista (10 itens), CTA-URL | janela 24h | **não** | "Resumo / PDF / Planilha / Abrir" em vez de SIM/NÃO por texto |

Limites que mandam no desenho: 4.096 chars por texto; header de documento em
template exige exemplo aprovado pela Meta; `media_id` vale 30 dias (sobe a
cada envio, sem cache); template de relatório é categoria UTILITY (mais
barato que MARKETING) porque a própria pessoa pediu o alerta.

## 2. Princípios

1. **Uma fonte de dado: `blocks`.** O alerta renderiza EmeBlock. Tool que
   ainda não devolve `blocks` passa por `legacyToBlocks` no back (porta do
   adaptador do front + os `*_summary` que o front embrulha como legacy).
   Forma que nem o adaptador conhece: texto "Resumo não disponível neste
   formato" + link para abrir no Office. **JSON nunca mais sai para o
   celular.**
2. **Número tem tipo.** Moeda `R$ 1,2 mi` / `R$ 45.300`, percentual `12,5%`,
   data `14/09`, mês `set/26`. Formatação numa função só
   (`formatarValor(valor, type)`), compartilhada por texto, PDF e XLSX.
3. **O canal decide o formato, a regra decide a preferência.** Padrão
   global na automação `alert_generic` (portal WhatsApp), sobrescrito por
   regra (`alert_rules.delivery`). Constante só como fallback
   (`feedback_always_configurable`).
4. **Comportamento do que já existe não muda sem pedir.** SIM/NÃO continua
   funcionando; a cadeia de fallback de template (`v2 → v1`) ganha o novo
   template na frente, sem janela de queda enquanto a Meta aprova.
5. **PDF é PAPEL**: HTML próprio, sem tokens do design system (mesma regra
   do `buildPrintHtml` das fichas). Identidade do meeting HTML
   (`project_meeting_html_padrao`).

## 3. Desenho

### 3.1 Renderer (`services/alerts/AlertReportRenderer.js`, novo)

```
blocksDe(raw)                 → EmeBlock[]   (blocks || legacyToBlocks(raw))
renderPreview(blocks, rule)   → string (≤ 120 chars)  linha do template/sino
renderWhatsAppText(blocks, rule, { limite: 3800 }) → string
renderHtml(blocks, rule, ctx) → string     (papel; entrada do PDF)
renderXlsxRows(blocks)        → [{ sheet, columns, rows }] | null
```

Regras do texto por `kind`:

- `kpis` → uma linha por KPI: `▸ *VGV*  R$ 1,2 mi` (+ `hint`/`delta` em itálico).
- `dataset` → cabeçalho `> período · fonte`, `Total: N`, top N linhas como
  lista `- *label*  valor1 · valor2` usando as colunas com `priority` (ou as
  3 primeiras), formatadas pelo `type`. Corte: N = 10; acima disso,
  `_… e mais K linhas - planilha completa em anexo_` (liga com a fase 2).
- `cards` → `- *title*` + `subtitle` + até 2 `fields`.
- `detail` → `▸ *label*: valor`, por seção.
- `text` → como está. `nav`/`choice`/`confirm`/`legacy` → ignorados.
- Vários blocos: separador em branco entre eles; o `title` do 1º vira o
  título quando a regra não tem.

`legacyToBlocks` (back, `services/OfficeAI/legacyBlocks.js`): `table` →
dataset; `chart` → dataset com `parteDeUmTodo` + kpis do `top_breakdown`;
`detail` → detail; `reservas_summary` / `precadastros_summary` /
`repasses_summary` → kpis (mapa explícito de chave → label/type, ex.
`taxa_venda` → "Taxa de venda", `percent`; `valor_financiado` → `currency`);
`*_cards` → cards (`items`/`cards` com `title`/`name`); objeto com `totals`
ou `kpis` → kpis; resto → `[]` (vira o texto de indisponível).

### 3.2 Anexos (`services/alerts/AlertAttachmentService.js`, novo)

- `gerarPdf({ html, filename })`: Playwright `page.pdf` (mesmo caminho do
  `academy/certificatePdfService.js`), A4, margens 12 mm, `printBackground`.
  HTML: cabeçalho (logo Menin + título + período + "gerado em"), KPIs em
  cartões, gráfico de barras em SVG puro (sem echarts; barra horizontal por
  linha quando `dataset.parteDeUmTodo` ou ≤ 12 linhas), tabela completa
  (todas as linhas, zebra, alinhamento numérico à direita), rodapé com a
  rota do Office. Sem gráfico quando o dado não é série.
- `gerarXlsx({ blocks })`: lib `xlsx` já no projeto; uma aba por `dataset`,
  cabeçalho = `label`, célula numérica numérica (não string), formato `R$`
  e `%` pelo `type`.
- Nome do arquivo: `Alerta - <nome da regra> - <dd-mm-aaaa>.pdf|xlsx`.
- Upload: `WhatsAppService.uploadMessageMedia` a cada envio (id vale 30
  dias; não guardar).

### 3.3 Template novo (registry + Meta)

`alert_report_v1` (UTILITY, pt_BR), `managedBy: 'automacao'`,
`automationKey: 'alert_generic'`, entra ANTES de `alert_generic_v2` na
cadeia `ALERT_TEMPLATES`:

```
HEADER   DOCUMENT
BODY     Olá {{1}}, o seu relatório *{{2}}* está pronto.
         {{3}}
         O PDF está em anexo. Responda *RESUMO* para ver aqui, ou
         *PLANILHA* para receber os dados completos.
FOOTER   Eme · Menin Office
BUTTONS  [URL] Abrir no Office  → https://office.menin.com.br{{1}}
```

`{{3}}` = preview (≤ 200 chars). Botão URL dinâmico usa o `urlButtonParam`
que `sendTemplate` já suporta (rota de `toolToRoute`). Criação pelo
`createTemplate` com `headerDocumentHandle` de um PDF de exemplo gerado pelo
próprio renderer (upload resumable já existe).

Enquanto `alert_report_v1` não estiver APPROVED, `pickApprovedTemplate` cai
em `alert_generic_v2` e o fluxo continua o de hoje (texto após SIM), mas já
com o renderer novo.

### 3.4 Preferência de entrega (configurável)

- `alert_rules.delivery` JSONB (sync alter):
  `{ format: 'pdf' | 'text' | 'xlsx', attach_on_fire: true, ask_first: false }`.
  `null` = herda o padrão global.
- Padrão global: `whatsapp_automations['alert_generic'].delivery` (mesmo
  shape), editável na tela do portal WhatsApp (aba Automações).
- Tela `/settings/alerts` (`AlertEditModal.vue`) e `ChatAlertEditor.vue`
  ganham o campo "Como entregar no WhatsApp": *PDF em anexo* (padrão) /
  *Só o resumo em texto* / *Planilha*; e o toggle "Perguntar antes de
  mandar" (= fluxo SIM/NÃO atual). `create_alert`/`update_alert` da Eme
  aceitam `delivery`.

### 3.5 Fluxo depois da mudança

```
fire ──► blocks ──► preview + texto + (pdf|xlsx conforme delivery)
   │
   ├─ delivery.ask_first=false e alert_report_v1 aprovado:
   │      template alert_report_v1 (PDF no header, botão Abrir no Office)
   │      pending_reply guarda texto + blocks (para RESUMO/PLANILHA)
   │
   └─ senão: template alert_generic_v2 (SIM/NÃO) como hoje

resposta (janela 24h, AlertReplyHandler):
   SIM / RESUMO   → sendText(texto)  [+ XLSX se dataset truncado e format≠text]
   PLANILHA       → sendDocument(xlsx)
   PDF            → sendDocument(pdf)
   NÃO            → cancela
   outra coisa    → (fase 3) sendInteractive lista: Resumo / PDF / Planilha / Abrir
```

`report_payload` passa a guardar `{ text, blocks, route }` (JSON string);
leitura tolerante ao formato antigo (string pura = texto).

## 4. Fases

**Fase 1 - Parar de quebrar (renderer por blocks).**
`legacyBlocks.js`, `AlertReportRenderer.js` (preview + texto),
`AlertReportService` passa a delegar; `formatarValor` compartilhado;
`report_payload` em JSON. Teste `tests/alertRenderer.test.mjs` com um
fixture por forma (`reservas_summary`, `repasses_summary`, `table`, `chart`,
`report_cards`, tool com `blocks`, forma desconhecida) provando que
**nenhuma saída contém `{` de JSON** e que moeda/percentual/data saem
formatados.
Pronto quando: `preview_alert` das 13 tools citadas na descrição de
`preview_alert` (AlertTools.js) devolve texto legível, e o teste passa.

**Fase 2 - PDF e planilha no disparo.**
`AlertAttachmentService` (PDF Playwright + XLSX), template `alert_report_v1`
no registry e criado na Meta, `ALERT_TEMPLATES` com o novo na frente,
`sendInitialAlert` sobe o PDF e manda com header, `AlertReplyHandler`
entende RESUMO/PLANILHA/PDF. `delivery` no model + padrão global na
automação (sem tela ainda: valor gravado pelo `ensure*`).
Pronto quando: um alerta real de reservas chega no celular como PDF com
botão "Abrir no Office", e responder PLANILHA devolve o XLSX. Registrar
`whatsapp_messages.type = 'document'` e o custo em `WhatsAppPricing`.

**Fase 3 - Preferência na tela + interativo.**
Campo "Como entregar" em `AlertEditModal.vue`, `ChatAlertEditor.vue` (ou
`VizForm`, se a fase 3 do plano da galeria tiver chegado) e na aba
Automações do portal WhatsApp; `create_alert`/`update_alert` aceitam
`delivery`. `WhatsAppService.sendInteractive({ buttons | list })`; na janela
24h o nudge "não entendi" vira lista com 4 opções; o payload do botão entra
no `AlertReplyHandler` pelo mesmo `context.id`. PageHelp das telas tocadas
atualizado (`feedback_page_instructions`).
Pronto quando: trocar o formato na tela muda o que chega no próximo disparo
sem restart, e tocar "Planilha" na lista devolve o XLSX.

**Fase 4 - Gráfico como imagem (opcional, depois de 01/10).**
`sendImage` com PNG do SVG do PDF (Playwright screenshot) quando o bloco é
série; legenda = KPIs. Só se a diretoria pedir depois de ver o PDF.

## 5. Critérios transversais

- Texto ≤ 3.800 chars sempre; corte por bloco inteiro, nunca no meio da linha.
- Dry-run (`whatsapp_config.dry_run`) registra `whatsapp_messages` com o
  nome do arquivo e o tamanho, sem subir mídia.
- Falha ao gerar PDF NÃO derruba o alerta: cai para `alert_generic_v2` +
  texto, e loga `error_code = 'PDF_FAILED'` no `alert_trigger_logs`.
- Duas instâncias no Railway: o lock de dedup do `fire` já cobre; a geração
  do PDF fica DEPOIS do lock.
- Playwright em produção: `postinstall` já instala o chromium
  (`package.json`); medir tempo do `page.pdf` (meta: < 4 s) e registrar no
  log do disparo.
- E-mail ganha o mesmo PDF em anexo quando `channels.email` (o
  `NotificationService` já recebe `emailData`; ver se aceita `attachments`,
  senão fica para depois e anota aqui).

## 6. O que NÃO entra

- Mudar o fluxo do Eme Atende, boletos ou parcelas (outro número/outro dono).
- Relatórios da Eme (`/r/<token>`) como anexo: o alerta é da tool, não do
  relatório; se quiser "relatório X toda segunda", é feature à parte.
- Biblioteca de gráfico no back (SVG à mão no PDF é suficiente).
- Template por regra (cada alerta com seu texto na Meta): custo de aprovação
  não compensa; o corpo é genérico e o PDF carrega o conteúdo.

## 7. Arquivos

Back (`Meninger-Back`):
- novo `services/OfficeAI/legacyBlocks.js`
- novo `services/alerts/AlertReportRenderer.js`
- novo `services/alerts/AlertAttachmentService.js`
- `services/alerts/AlertReportService.js` (delega), `AlertEngine.js`
  (`ALERT_TEMPLATES`, `sendInitialAlert`), `AlertReplyHandler.js` (palavras
  RESUMO/PLANILHA/PDF, documentos)
- `services/whatsapp/whatsappTemplateRegistry.js` (`alert_report_v1`),
  `WhatsAppService.js` (`sendInteractive`, fase 3),
  `WhatsAppAutomationService.js` (`delivery` padrão), `WhatsAppPricing.js`
- `models/sequelize/alerts/alertRule.js` (`delivery`),
  `alertPendingReply.js` (comentário do `report_payload` em JSON)
- `services/OfficeAI/AlertTools.js` (`delivery` em create/update)
- `tests/alertRenderer.test.mjs`

Front (`Meninger-Front`):
- `src/config/changelog.js` (`v3.17.0`, já escrita; publicar = data)
- `views/Office/Settings/Alerts/components/AlertEditModal.vue`,
  `components/OfficeAI/renderers/ChatAlertEditor.vue`, portal WhatsApp aba
  Automações (fase 3)

## 8. Execução (registro)

(preencher a cada fase: data, commit, o que ficou de fora e por quê)
