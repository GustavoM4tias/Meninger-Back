# Relatórios da Eme - Relatórios customizados por IA no Office

> Spec inicial - 2026-07-22. Decisões tomadas com o Gustavo nesta data.
> Referência visual do padrão: `referencia-relatorio-inga.html` (relatório comercial do Residencial Ingá gerado via chat e aprovado como padrão de qualidade).

## 1. Visão geral

Novo menu **Relatórios** no Office onde um admin conversa com a Eme, dá instruções do que quer (leads, pré-cadastro, reservas, vendas, CC do Sienge e demais dados que a Eme já acessa), e a Eme gera um relatório visual no padrão da casa. O usuário vê o resultado em andamento (preview ao vivo), pede ajustes na conversa até ficar satisfeito, e confirma/publica. O relatório pode ser privado, compartilhado internamente ou público com URL de compartilhamento.

## 2. Decisões tomadas (2026-07-22)

1. **Motor híbrido com repertório grande de blocos.** A maioria do relatório é montada com blocos pré-definidos (JSON de spec renderizado por um renderer fixo). O repertório de blocos deve ser GRANDE para cobrir a maioria dos casos. Quando um bloco não cobrir a necessidade, a Eme pode gerar HTML livre num bloco `custom-html`. Se esse HTML livre se mostrar importante/recorrente, ele deve ser **promovido a bloco oficial** (pipeline de promoção).
2. **Dois modos de dados, escolha do usuário por relatório:**
   - `fixed`: período fechado, dados congelados em snapshot no momento da geração. Auditável, nunca muda.
   - `live`: data inicial definida e fim em aberto ("até hoje"); as queries re-executam no acesso (com cache) e os números acompanham a realidade.
3. **Escopo: tudo de uma vez.** Primeira entrega já inclui builder + privado + interno + público com URL.
4. **Geração admin-only** no início, controlada por alçadas em `/settings/permissions` (padrão da casa), para liberar a outros perfis depois só por configuração.

## 3. Arquitetura em 4 camadas

O princípio central: a IA nunca escreve o relatório inteiro nem inventa número.

1. **Dados** - queries determinísticas via tools da Eme (aproveitar a base do Brain Studio, que já tem relatórios com SQL guardado). A Eme pede o dado, o backend devolve o valor real.
2. **Narrativa** - textos de análise, insights, pontos fortes e de atenção: aqui a Eme escreve livremente.
3. **Estrutura (spec)** - o relatório é um JSON de blocos ordenados. A Eme cria e edita esse JSON via patches, não HTML.
4. **Renderização** - renderer fixo: componente Vue no builder/preview, e render estático server-side para URL pública e export. Design congelado e consistente (padrão Ingá), mobile-first (diretoria acessa pelo celular).

Ajuste durante a amostragem = patch no JSON = re-render instantâneo do bloco alterado. Barato e rápido.

## 4. Catálogo inicial de blocos (repertório)

Extraído do relatório do Ingá + necessidades previsíveis. Cada bloco tem schema próprio (props tipadas) e exemplos no prompt da Eme.

**Estrutura e texto**
- `hero` - capa: título, subtítulo, tags/chips, empreendimento, período, data de geração
- `section-header` - número da seção + título + descrição (padrão snum/stitle/sdesc do Ingá)
- `narrative` - texto rico de análise (markdown restrito)
- `highlight-list` - listas de destaque em grupos (ex.: pontos fortes × pontos de atenção, com ícone e tom por grupo)
- `insight-box` - caixa de insight/citação/nota de rodapé
- `divider`, `note`, `footer` (fonte dos dados, gerado por, carimbo de data)

**Números**
- `stat-row` - linha de KPIs (label, valor, variação, tom)
- `big-number` - número hero com contexto
- `progress-goal` - barra de progresso contra meta (ex.: vendas × demanda mínima)
- `comparison` - comparativo lado a lado (períodos, empreendimentos, canais)

**Gráficos** (renderer próprio, paleta do design system, sem lib externa pesada)
- `chart-bar` (vertical/horizontal, agrupado/empilhado)
- `chart-line` (séries temporais, ex.: leads por semana)
- `chart-donut` (participação/composição)
- `chart-funnel` - funil etapa por etapa com taxas de conversão (peça central dos relatórios comerciais)
- `sparkline` / `minibar` - micro-gráficos embutidos

**Tabelas e mídia**
- `table` - tabela com formatação por coluna (moeda, %, data), zebra, totais
- `timeline` - linha do tempo de eventos/marcos
- `image` - imagem (upload ou URL do Supabase)
- `map-info` - localização/legenda do empreendimento (existia no Ingá)

**Escape hatch**
- `custom-html` - HTML livre gerado pela Eme, sandboxado no render (sem script externo). Todo `custom-html` fica marcado para revisão de promoção.

### Pipeline de promoção de bloco
- Tela admin (dentro das configurações de Relatórios ou do Brain Studio) lista os `custom-html` em uso, com contagem de reuso.
- Admin decide "promover": vira bloco oficial parametrizado (trabalho de dev: extrair props + componente). A Eme passa a conhecê-lo via catálogo.
- A própria Eme pode sugerir promoção quando perceber que repetiu um custom-html parecido.

## 5. Fluxo do usuário (builder) - experiência em DUAS FASES da Eme

A Eme tem um componente EXCLUSIVO para relatórios (não é o player flutuante genérico do Office), com duas fases:

### Fase A - Criação (componente dedicado, protagonista)

1. Menu **Relatórios** → "Novo relatório" (admin-only). Abre o `ReportBuilder` com a Eme em destaque.
2. A Eme conduz de forma guiada e interativa, em etapas visíveis:
   - **Entender o pedido**: usuário dá a instrução inicial ("relatório comercial do Ingá com leads, pré-cadastro e reserva do trimestre").
   - **Estruturação de regras**: a Eme confirma/pergunta parâmetros com chips e escolhas clicáveis (empreendimento, período, modo de dados fixed/live, seções desejadas) - não só texto livre; respostas rápidas de um toque.
   - **Busca dos dados**: cada tool executada aparece como item de progresso no componente ("Buscando leads... ok - 342 leads", "Reservas... ok"), com check/erro por fonte. O usuário VÊ o que ela está coletando.
   - **Montagem**: preview renderiza seção por seção conforme o streaming do spec.
3. Rascunho é persistente (sair da tela e voltar mantém conversa, etapas e spec).

### Fase B - Refinamento (Eme flutuante sobre o relatório)

4. Quando a maior parte do relatório carregou, a interface TRANSICIONA: o relatório assume a tela inteira e a Eme vira um **componente flutuante** ancorado (canto inferior), recolhível.
5. A Eme flutuante mostra o **outline dos itens/blocos** do relatório (lista das seções e blocos com status). Funções:
   - Clicar num item do outline → scroll até o bloco no relatório.
   - Selecionar um bloco no próprio relatório (hover → "Editar com a Eme") → o chat flutuante abre já com o contexto daquele bloco ("o que quer mudar no gráfico de leads?").
   - Pedidos gerais continuam valendo ("resume a seção 3", "adiciona comparativo com o Verona") - cada turno = patch no spec, re-render só do que mudou, com highlight do bloco alterado.
6. **Confirmar/Publicar** → grava versão. Pós-publicação: visibilidade, compartilhar, exportar, ou continuar editando (nova versão de rascunho sem afetar a publicada).
7. Mobile: Fase A em tela cheia com etapas; Fase B com a Eme como bottom sheet flutuante sobre o relatório.

## 6. Modos de dados

- **`fixed`**: no publish, todas as queries executam e o resultado é gravado em `data_snapshot`. Render sempre usa o snapshot. Botão "Atualizar dados" re-executa e cria nova versão (a antiga fica no histórico).
- **`live`**: o spec guarda as queries parametrizadas (referências a relatórios/SQL do Brain Studio + parâmetros). No acesso, o backend re-executa com role restrita e cacheia (TTL ~15 min) o `last_snapshot` + `refreshed_at` exibido no rodapé ("dados de HH:mm").
- URL pública NUNCA executa query diretamente por input do visitante: rota pública só dispara o refresh do cache server-side; visitante recebe HTML renderizado.

## 7. Visibilidade e compartilhamento

- **Privado**: só o dono (e admins no painel admin).
- **Interno**: dono escolhe usuários e/ou cargos do Office; aparece em "Compartilhados comigo". (Padrão simples de lista de acesso; diferente do share de Alertas, aqui não há clone - todos veem o mesmo relatório.)
- **Público**: gera `public_token` (CSPRNG, não sequencial) → URL `office.menin.com.br/r/<token>` servida sem login (rota fora do auth, com rate-limit).

### Segurança do link público (prioridade)

Tornar público é a ação mais sensível do módulo - dado comercial na internet. Regras:

1. **Fluxo de confirmação obrigatório** (modal em 2 passos):
   - Passo 1 - resumo do que será exposto: título, empreendimento, período, lista das fontes de dados usadas (leads, reservas, valores...) e aviso de que qualquer pessoa com o link acessa sem login.
   - Passo 2 - checagem automática de conteúdo sensível antes de liberar: scan do spec/snapshot procurando PII (nome de cliente, CPF, telefone, e-mail) e a Eme emite parecer ("este relatório contém X, recomendo remover antes de publicar"). Se detectar PII, bloqueia até o usuário remover ou justificar com confirmação extra.
   - Checkbox explícito "Entendo que este conteúdo ficará acessível publicamente" antes do botão liberar.
2. **Vencimento OBRIGATÓRIO**: todo link público tem `public_expires_at`. Default 30 dias, opções 7/15/30/90 ou data custom; sem opção "nunca expira". Após vencer, a URL mostra página neutra "relatório expirado" (sem vazar título/conteúdo). Notificação ao dono D-3 antes de vencer (via NotificationService) com ação de renovar em 1 clique.
3. **Revogação e rotação**: revogar link (imediato) e regenerar token (invalida o antigo) a qualquer momento, na tela do relatório e no painel admin.
4. **Auditoria**: log de acessos do link público (timestamp, IP, user-agent) e contador de visualizações visível ao dono; painel admin lista todos os links públicos ativos da empresa com vencimento e acessos.
5. **Congelamento no público**: link público sempre serve snapshot renderizado (mesmo em relatório `live`, o público recebe o cache server-side; visitante nunca dispara query). Editar o relatório depois de público não altera o que o link mostra até o dono republicar.
6. **Higiene HTTP**: `X-Robots-Tag: noindex, nofollow`, sem sitemap, headers de cache privado, rate-limit por IP na rota `/r/:token`, 404 genérico para token inválido/revogado (não distinguir "não existe" de "revogado").
7. **Downgrade seguro**: mudar visibilidade de público para interno/privado revoga o token automaticamente.
- Export: **baixar HTML autocontido** (mesmo formato do arquivo de referência, fontes embutidas) e **PDF**.

## 8. Permissões

- Alçada `reports.generate` (criar/editar via Eme) - default: admins.
- Alçada `reports.admin` (painel de todos os relatórios, promoção de blocos, revogar links) - admins.
- Visualização interna: pela lista de acesso do relatório, sem alçada.

## 9. Modelo de dados (Sequelize, sync alter - cuidado com índices novos)

> NOTA (2026-07-22, início da implementação): a tabela `eme_reports` JÁ EXISTE no Brain Studio (catálogo de tools/relatórios da Eme). Para evitar colisão, as tabelas deste módulo usam o prefixo `eme_generated_report*`.

- `eme_generated_reports`: id, owner_id, title, empreendimento (opcional), status (`draft`/`published`), data_mode (`fixed`/`live`), period_start, period_end (null = aberto), visibility (`private`/`internal`/`public`), public_token (unique, nullable), public_expires_at, spec JSONB, data_snapshot JSONB, refreshed_at, html_cache TEXT, created/updated
- `eme_generated_report_versions`: report_id, version, spec, data_snapshot, published_at, published_by
- `eme_generated_report_messages`: report_id, role, content, tool_calls JSONB, created_at (thread da conversa vive no relatório)
- `eme_generated_report_access`: report_id, user_id | role_name (acesso interno)
- `eme_generated_report_public_log`: report_id, accessed_at, ip, user_agent (auditoria do link público; `public_expires_at` é NOT NULL quando visibility = public)
- `eme_generated_report_custom_blocks`: registro dos custom-html em uso (hash, html, uso_count, status `em_uso`/`promovido`/`descartado`) para o pipeline de promoção

## 10. Rotas

- `/api/reports` CRUD + `POST /:id/chat` (streaming, mesmo padrão Gemini da Eme) + `POST /:id/publish` + `POST /:id/refresh-data` + `POST /:id/share` + `POST /:id/public-token` (gerar/revogar) + `GET /:id/export.html|.pdf`
- Pública: `GET /r/:token` (sem auth, rate-limit, serve html_cache; live → refresh com TTL)
- Admin: `GET /api/reports/admin` + rotas de promoção de blocos

## 11. Frontend (Vue, design system do Office)

- `/relatorios` - lista (meus, compartilhados comigo; admin vê aba "todos")
- `/relatorios/novo` e `/relatorios/:id` - builder split chat+preview
- `/relatorios/:id/view` - visualização limpa (a mesma usada no público)
- Componentes da Eme exclusivos do módulo (`components/Reports/eme/`):
  - `EmeReportBuilder` - Fase A: chat guiado com etapas, chips de escolha rápida (empreendimento/período/modo), lista de progresso das tools de dados (item por fonte com check/erro), streaming da montagem.
  - `EmeReportFloat` - Fase B: flutuante ancorado recolhível sobre o relatório, com outline dos blocos (clique → scroll), chat contextual e recebimento de contexto do bloco selecionado.
  - `BlockSelectOverlay` - hover/tap num bloco do relatório → ação "Editar com a Eme" que injeta o contexto no `EmeReportFloat`.
  - Transição A→B automática quando o spec estabiliza (maioria das seções renderizadas), com opção manual de alternar.
- PageHelp em toda tela (padrão da casa). Mobile-first: preview e relatório final perfeitos em 375px; tabelas com scroll/cards; alvos ≥40px; `EmeReportFloat` vira bottom sheet no mobile.
- Renderer de blocos: `components/Reports/blocks/*` - um componente por bloco, tokens semânticos, dark mode. O MESMO renderer gera o HTML estático server-side (SSR simples ou template compartilhado) para `/r/:token` e export.

## 12. Integração Eme

- Tools novas no namespace da Eme (Office, não Eme Atende): `report_get_data` (executa query do catálogo com parâmetros), `report_set_spec` / `report_patch_spec`, `report_ask_user` (quando faltar parâmetro).
- Catálogo de dados: reaproveitar/expandir os relatórios com SQL guardado do Brain Studio; cada entrada tem descrição para a Eme escolher.
- System prompt do modo relatório: catálogo de blocos com schemas e exemplos, regras do padrão visual, proibição de inventar números (todo número vem de tool).
- Economia de tokens: o spec vive no backend; a Eme trabalha com patches e resumos, não re-emite o JSON inteiro a cada turno.

## 13. Ordem de construção (entrega única, mas nesta sequência interna)

1. Modelos + módulo backend `emeReports` (patch idempotente no boot, sem script manual)
2. Renderer de blocos no front + catálogo inicial (usar o relatório do Ingá como gabarito: reconstruí-lo 100% com blocos é o teste de aceitação do catálogo)
3. Tools + chat streaming + builder split com preview
4. Publish, versões, modos fixed/live
5. Compartilhamento interno + público (`/r/:token`) + export HTML/PDF
6. Painel admin + pipeline de promoção de blocos
7. `vite build` para validar front (nunca subir preview/dev server)

## 14. Pontos de atenção

- Dado comercial em URL pública: token forte, revogação, confirmação explícita, rate-limit, sem PII de clientes em relatório público (a Eme deve ser instruída a agregar, nunca listar nomes/CPF em relatórios que possam ir a público).
- Relatório `live` público = carga no banco: cache TTL obrigatório.
- `custom-html` sandboxado: sem `<script>` externo, sem fetch; sanitizar no backend antes de gravar.
- Comportamento congelado: nada disso toca telas/fluxos existentes do Office; é módulo novo.
