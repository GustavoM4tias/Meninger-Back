# Eme Atende - Atendente IA de Leads via WhatsApp

> **PIVOT 2026-07-03: a Eme virou MÓDULO DO OFFICE (Meninger-Back), não mais serviço separado.**
> Motivos: integração profunda (mover etapa de lead, tocar outros pontos do sistema), infra única, e o produto final é do Office. Mudanças em relação a este plano original:
> - Código em `models/sequelize/emeAtende/`, `services/emeAtende/`, `routes/emeAtendeRoutes.js` + `emeAtendePublicRoutes.js` (montadas em `/api/eme-atende`).
> - SEM forward por HTTP e SEM envs `MIA_*` obrigatórias: o `EmeAtendeWebhookRouter` roda in-process no webhook do Office.
> - **Número COMPARTILHADO com o Office** (decisão do Gustavo): roteamento por REMETENTE (user interno → Office; externo → Eme) e statuses pelo dono do wamid. Gate em `eme_atende_settings.active` (default false = comportamento atual intacto).
> - Templates: reusa `whatsapp_templates` + sync/criação já existentes no Office (tela WhatsApp / whatsapp-automations).
> - Auth admin: JWT + admin do Office (sem token separado).
>
> O restante do plano abaixo segue válido como referência de produto (fluxos, motor, restrições da Meta, fases).

> Produto que recebe leads de outros sistemas, segmenta em fluxos de atendimento e conversa com o lead no WhatsApp usando IA com regras/comportamentos editáveis pelo usuário.

**Nome:** Eme (2026-07-03: o nome "Eme" foi DESCARTADO - é a assistente da MRV). A mesma marca Eme atende dentro (Office) e fora (lead); tecnicamente o módulo se chama **Eme Atende** (namespace eme_atende_*/EmeAtende*, porque Eme*/eme_* puro já é do Brain Studio).

---

## 1. Veredito sobre a ideia (api/webhook)

A ideia está certa e é o padrão de mercado. Todas as ferramentas desse tipo (Blip, Zaia, SleekFlow, ManyChat) funcionam exatamente assim: webhook de entrada de leads + WhatsApp Cloud API + motor de regras/IA. Não precisa mudar o conceito.

### Prontos avaliados (e por que construir)

| Opção | O que é | Por que não |
|---|---|---|
| Zaia / GPT Maker (SaaS BR) | Agente IA WhatsApp pronto | Mensalidade por agente, dados fora, sem integração profunda com Office/CV, não é "nosso produto" |
| Chatwoot (open source) | Inbox multicanal + bots | Ótimo para inbox humano, fraco como motor IA configurável; adotar depois só para a fase de transbordo humano, se precisar |
| Typebot (open source) | Construtor de fluxo visual | Fluxo de árvore fixa, não conversa livre com IA; o objetivo aqui é IA com instruções, não árvore de botões |
| n8n | Orquestrador | Vira gambiarra difícil de produtizar; bom para protótipo, ruim para produto |

**Decisivo:** o Meninger-Back já tem ~80% do trabalho difícil pronto e testado em produção:
- `services/whatsapp/WhatsAppService.js` - cliente Cloud API completo (sendText, sendTemplate, createTemplate, subscribeWaba, healthCheck)
- `WhatsAppWebhookService.js` - handshake, HMAC, parse de inbound (texto, botão, interactive), opt-out por palavra
- `services/OfficeAI/geminiClient.js` + `OfficeChatService.js` - Gemini com rotação de chaves, function calling
- Pipeline de leads (`inbound_leads`, `LeadCaptureService`) - fonte natural de leads para a Eme
- Padrões prontos: criptografia de segredos, `sync({alter})`, notificações

Construir a Eme é montar essas peças num serviço novo, não escrever do zero. Nenhum SaaS entrega isso em 1 dia COM a integração ao nosso ecossistema.

---

## 2. Arquitetura

```
Sistemas de leads                    Meta (WhatsApp Cloud API)
(Office/CV/site/qualquer)                    ▲ │
        │ POST /api/v1/leads                 │ ▼ webhook (por App)
        ▼ (API key)                   Office /api/whatsapp/webhook
┌─────────────────────┐                      │
│      mia-back        │◄─── forward por ────┘
│  Node/Express/Sequelize   phone_number_id da Eme
│  Postgres (Railway)  │    (~15 linhas no Office)
│                      │
│  Intake → Segmentação → Fluxo → Motor IA (Gemini) → Envio
└─────────────────────┘
        │ admin REST (dia 1) / mia-front (fase 2)
```

### Decisões

1. **Serviço separado** (`mia-back (nome antigo, removido)`): repo/deploy próprio no Railway, banco Postgres próprio. Mesma stack do Meninger-Back (Node ESM + Express + Sequelize + sync alter) para copiar código sem atrito.

2. **Meta: mesmo App (785502081163165), mesma WABA, telefone NOVO dedicado.**
   - O webhook do WhatsApp é configurado por App, e o App já aponta para o Office. Toda mensagem chega com `metadata.phone_number_id`.
   - **Tap no Office:** no `whatsappWebhookController`, se o `phone_number_id` do evento for o da Eme, faz POST do payload cru para `(obsoleto - in-process)` (com um segredo compartilhado) e responde 200. O número atual do Office continua intocado (regra de comportamento congelado respeitada: só adiciona um encaminhamento, não muda nada do fluxo existente).
   - Envio de mensagem a Eme faz direto na Graph API com o `phone_number_id` dela (token System User já existente tem `whatsapp_business_messaging` na WABA toda).
   - Fase 2 (se virar produto vendável): App Meta próprio + WABA por cliente. Não fazer agora.

3. **"Telefone do usuário" - atenção:** número registrado no Cloud API SAI do WhatsApp comum/Business App (a pessoa deixa de usar o número no celular; existe modo coexistência mas é beta e arriscado). Para o MVP: **chip novo dedicado** (pré-pago serve, só precisa receber 1 SMS de verificação). Não usar o número pessoal de ninguém.

4. **Leads entram por API genérica:** `POST /api/v1/leads` com header `X-Api-Key`. Qualquer sistema consegue integrar (Office, CV, site, Zapier). No Office, um hook opcional no `LeadCaptureService` reencaminha leads novos para a Eme (espelho do que já faz com o CV). Assim a Eme nasce conectada à base real sem esperar terceiros.

---

## 3. Modelo de dados (mia-back, Postgres)

```
settings          - singleton: phone_number_id, waba_id, access_token(enc),
                    forward_secret, dry_run, active, opener_template
api_keys          - name, key_hash, active (quem pode postar leads)
leads             - name, phone(normalizado), email, source, campaign,
                    empreendimento, payload(jsonb), flow_id, status
                    (received|opened|engaged|qualified|handoff|closed|opted_out)
flows             - name, active, is_default,
                    system_prompt (comportamento/persona editável),
                    business_context (texto livre: empreendimentos, preços, plantão),
                    opener_template + opener_vars (template Meta que abre a conversa),
                    triggers (jsonb: [{match: keyword|intent, value, action}]),
                    handoff_config (jsonb: para quem, como avisa),
                    settings (jsonb: debounce_s, max_msgs, horario)
flow_rules        - ordered: field (source|campaign|empreendimento|regex),
                    operator, value → flow_id  (segmentação da base)
conversations     - lead_id, phone, flow_id, state (bot|human|closed),
                    last_inbound_at (controle da janela de 24h)
messages          - conversation_id, direction, type, body, wamid,
                    status (sent|delivered|read|failed|dry_run), raw(jsonb)
events            - trilha de auditoria por lead (recebido, fluxo X, opener
                    enviado, trigger Y disparou, handoff...)
```

Regras dos memos aplicadas: STRING em vez de ENUM, segredos criptografados (AES via chave derivada de env estável), `sync({alter:true})`.

---

## 4. Motor de conversa (o coração)

**Lead novo (business-initiated - a Meta EXIGE template aprovado):**
1. `POST /api/v1/leads` → normaliza telefone (regra dos 8/9 dígitos já resolvida no AlertReplyHandler, copiar) → dedup por telefone.
2. `flow_rules` em ordem → primeiro match define o fluxo; sem match → fluxo default.
3. Envia o `opener_template` do fluxo (ex.: "Olá {{nome}}! Vi seu interesse no {{empreendimento}}. Posso te passar as informações por aqui?").
4. Status `opened`. Se o lead nunca responder, acabou (sem custo, sem spam).

**Lead respondeu (abre a janela de 24h - conversa livre):**
1. Webhook → forward do Office → grava inbound.
2. **Debounce de ~8s** (pessoas mandam 3 mensagens picadas; a IA responde 1 vez ao bloco).
3. Guardas ANTES da IA (determinísticas, não dependem do modelo):
   - opt-out (PARAR/SAIR/STOP) → `opted_out`, nunca mais contata
   - triggers do fluxo (ex.: "quero falar com corretor", "financiamento") → ação configurada (handoff, resposta fixa, tag)
   - `state=human` → não responde (humano assumiu)
   - janela de 24h vencida → não manda texto livre (só template)
4. Monta prompt: `system_prompt` do fluxo + `business_context` + dados do lead + histórico da conversa → Gemini (flash) com tools:
   - `handoff(motivo)` - transfere pra humano e avisa (notificação Office / WhatsApp do corretor)
   - `marcar_qualificado(resumo)` - lead quente, registra e avisa
   - `encerrar(motivo)` - despedida
5. Envia resposta via Cloud API, grava tudo em `messages` + `events`.
6. `dry_run=true` → tudo funciona mas loga em vez de enviar (mesmo padrão do Office, essencial pro teste do dia 1).

**Handoff:** conversa vira `state=human`, bot silencia, corretor recebe aviso com resumo + link. Responder pelo celular oficial (fase 2: inbox própria).

---

## 5. O que o usuário edita (sem código)

Tudo fica em `flows` no banco - editar é um PUT (dia 1) ou tela (fase 2), aplicando na conversa seguinte, sem deploy:
- **Comportamento** (system_prompt): tom, o que pode/não pode prometer, quando desistir
- **Contexto de negócio**: empreendimentos, diferenciais, condições, plantão
- **Gatilhos**: palavra/intenção → ação (handoff, resposta pronta, tag)
- **Segmentação** (flow_rules): "campanha contém Esmeralda → fluxo Esmeralda", "source=site → fluxo institucional"
- **Abertura**: qual template inicia cada fluxo

É a mesma filosofia do Brain Studio da Eme: config no banco com fallback seguro, zero deploy pra ajustar.

---

## 6. Restrições da Meta que moldam o produto (não dá pra contornar)

1. **Iniciar conversa = template aprovado** (categoria MARKETING ou UTILITY). Criar HOJE via `WhatsAppService.createTemplate` (aprovação leva de minutos a horas - é o item de maior risco do cronograma, fazer primeiro). Lembrete: header sem emoji/formatação (subcode 2388072).
2. **Janela de 24h**: texto livre só até 24h após a última mensagem DO LEAD. Venceu = só template de novo.
3. **Número novo começa limitado**: 250 conversas iniciadas/24h (sobe com qualidade + verificação do negócio, que a Menin já tem). Suficiente pro teste.
4. **Qualidade/bloqueios**: lead que marca spam derruba o rating do número. Opener curto, educado e com saída fácil. Opt-out imediato é obrigatório (e já protege na LGPD).
5. **Custo por conversa** (~R$0,04-0,50 conforme categoria): registrar `cost_category` em messages desde o dia 1 pra medir CAC depois.

---

## 7. MVP - 1 dia de desenvolvimento

**Manhã (bloco 1) - fundação + o item lento primeiro:**
- [ ] Criar template de abertura na Meta AGORA (aprovação corre em paralelo ao dev)
- [ ] Scaffold `mia-back` (Express + Sequelize + Postgres Railway) - copiar esqueleto do Meninger-Back
- [ ] Models + sync + seed de 1 fluxo default
- [ ] Copiar/adaptar: WhatsAppService (só sendText/sendTemplate), normalização de telefone, criptografia

**Tarde (bloco 2) - o motor:**
- [ ] `POST /api/v1/leads` (API key) + flow_rules + disparo do opener (com dry_run)
- [ ] Forward no webhook do Office por phone_number_id (mudança mínima, comportamento atual intocado)
- [ ] Motor de conversa: debounce + guardas + Gemini + tools (handoff/qualificado/encerrar) + envio
- [ ] CRUD REST de flows/rules/settings (sem tela; Postman/curl serve pro dia 1)

**Fim do dia (bloco 3) - teste real:**
- [ ] Registrar o chip dedicado na WABA (Meta Business → adicionar número)
- [ ] Deploy Railway, configurar settings, `dry_run=true` → curl de lead fake → conferir logs
- [ ] `dry_run=false` → lead com o próprio celular → conversa ponta a ponta → handoff

**Fica explicitamente FORA do dia 1:** tela admin (fase 2), inbox humana, áudio/imagem, follow-up automático, multi-número, relatórios.

## 8. Fases seguintes

- **F2 - Tela admin** (`mia-front` ou módulo no Office-front): editor de fluxos/regras, lista de conversas com transcript, sandbox de teste do prompt
- **F3 - Follow-up**: lead sumiu → re-engaja por template após X horas (cron); métricas (resposta, qualificação, custo)
- **F4 - Integração funil**: Eme registra interações/qualificação no CV CRM (a API de leads do CV já é conhecida); áudio (Whisper/Gemini) e imagem
- **F5 - Produtização**: multi-tenant, App Meta próprio, embedded signup (cliente conecta o próprio número), inbox humana (avaliar Chatwoot)

---

## Riscos honestos

1. **Aprovação do template** - único item fora do nosso controle no dia 1. Mitigação: criar de manhã, ter plano B (testar só o fluxo inbound: você manda "oi" pro número primeiro, o que abre a janela sem precisar de template).
2. **Chip dedicado em mãos** - sem número novo não tem teste real. Providenciar antes de começar.
3. **IA falando besteira** (prometer desconto, inventar preço) - mitigado pelo system_prompt restritivo + guardas determinísticas antes do modelo + handoff fácil; fase 2 adiciona revisão de transcripts.
4. **Forward no Office** - ponto de contato com sistema congelado; a mudança é aditiva (if + POST), mas testar que o fluxo atual de alertas/SIM continua intacto.
