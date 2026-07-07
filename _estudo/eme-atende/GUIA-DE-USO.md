# Eme Atende - Guia de uso: criar fluxos e testar

Tela: **Ferramentas › Inteligência (Eme) › Eme Atende** (`/tools/eme-atende`, admin only).

## Conceito em 30 segundos

- **Fluxo** = como a Eme atende um grupo de leads: persona + contexto de negócio + template de abertura + gatilhos.
- **Regras de segmentação** decidem qual lead cai em qual fluxo (a primeira que casar vence; sem match, cai no fluxo **default**).
- Tudo que você salva **vale na próxima mensagem** (cache de 30s no servidor). Zero deploy.
- Dois interruptores na aba Config mandam em tudo:
  - **Eme Atende ativa**: OFF = o WhatsApp se comporta 100% como hoje. ON = mensagens de números EXTERNOS (não-usuários do Office) vão pro atendimento da Eme.
  - **Modo sombra (dry run)**: ON = ela "responde" só no registro (status `dry_run` na conversa), nada sai pro WhatsApp. É a rede de segurança pra testar.

## Criar um fluxo (aba Fluxos)

1. Digite o nome (ex.: `Residencial Esmeralda`) → **Criar** → **Editar**.

2. **Comportamento da Eme** (persona) - quem ela é e como age:

```
Você é a Eme, assistente virtual da Menin Engenharia, atendendo interessados
no Residencial Esmeralda. Seu objetivo: entender o que o lead procura
(tamanho, orçamento, prazo, se é primeira compra) e, quando houver interesse
real, marcar como qualificado e oferecer um consultor. Tom: caloroso,
direto, sem forçar venda. Nunca pressione; se a pessoa não quiser, agradeça.
```

3. **Contexto do negócio** - A PARTE MAIS IMPORTANTE. É a única fonte de verdade: o que não estiver aqui ela NÃO afirma (regra fixa do sistema: proibido inventar preço/condição - na dúvida ela transfere pra humano). Exemplo:

```
RESIDENCIAL ESMERALDA (Maringá-PR)
- Aptos de 2 e 3 quartos, 54m² a 72m², varanda gourmet
- A partir de R$ 389.000 (tabela julho/2026)
- Entrada facilitada em até 36x; aceita FGTS e financiamento CEF
- Entrega prevista: dezembro/2027
- Plantão de vendas: seg a sáb 9h-18h, Av. XXX, 123
- Diferenciais: piscina, coworking, pet place, 2 vagas nos de 3 quartos
NÃO prometer: desconto além da tabela, mudança de prazo de obra.
```

4. **Template de abertura** - só necessário quando a EME INICIA a conversa (lead que entra por API/campanha). Se vazio, ela só responde quem manda mensagem primeiro. O dropdown lista os templates APROVADOS na Meta (os mesmos da tela de Automações WhatsApp - crie/sincronize por lá). **Variáveis** = campos do lead que preenchem {{1}}, {{2}}… na ordem: `name, empreendimento`.

5. **Gatilhos** (rodam ANTES da IA, determinísticos):

```json
[
  { "value": "corretor",  "action": "handoff" },
  { "value": "atendente", "action": "handoff" },
  { "value": "endereço",  "action": "reply", "reply_text": "Nosso plantão fica na Av. XXX, 123 - seg a sáb, 9h às 18h. 😊" }
]
```

Ações: `handoff` (transfere pra humano), `reply` (resposta fixa), `close` (encerra).

6. **Salvar**. Marque **default** no fluxo que deve pegar os leads sem regra.

## Segmentar a base (mesma aba, seção de baixo)

Ex.: Campo `Campanha` · contém · `Esmeralda` → fluxo `Residencial Esmeralda`. Prioridade menor = testa primeiro. Lead de qualquer origem sem match cai no default.

## Testar - 3 níveis, do mais seguro ao real

### Nível 1 - Sandbox (Config › Sandbox da Eme) - sem WhatsApp, sem lead
Escolha o fluxo, escreva como se fosse o lead ("quanto custa o de 2 quartos?", "quero falar com gente de verdade", "não tenho interesse") e veja a resposta. Os badges amarelos mostram quando ela chamaria `transferir_para_humano` / `marcar_qualificado` / `encerrar_conversa`. **Itere a persona/contexto aqui até gostar.**

### Nível 2 - Lead fake em modo sombra - testa o pipeline inteiro
1. Config › API keys → **Gerar** (ex.: `teste`) → copie a chave.
2. Poste um lead fake:

```bash
curl -X POST https://menin.up.railway.app/api/eme-atende/public/leads \
  -H "X-Api-Key: eme_atende_..." -H "Content-Type: application/json" \
  -d '{"name":"Lead Teste","phone":"44999990000","source":"teste","campaign":"CMP Esmeralda","empreendimento":"Residencial Esmeralda"}'
```

3. Aba **Leads**: o lead aparece com a timeline (`lead_received → flow_assigned → opener_sent/skipped`). Confira se caiu no FLUXO certo (é o teste da segmentação).
4. Aba **Conversas**: com dry_run ON, a abertura fica registrada como `dry_run` - nada foi enviado.

### Nível 3 - Conversa real (produção, com dry_run ainda ON)
O webhook da Meta aponta pro Railway, então mensagem de verdade só chega no ar (não no localhost).
1. Config: **ativa = ON**, **modo sombra = ON**.
2. De um celular que NÃO seja de usuário do Office (o seu pessoal serve, se ele não está cadastrado como whatsapp_phone de user), mande "oi" pro número do Office.
3. Aba Conversas: a conversa aparece, e a resposta da Eme está lá marcada `dry_run` (registrada, não enviada). Converse mais, veja como ela se comportaria.
4. Gostou? **Modo sombra = OFF** → a partir daí ela responde de verdade. Refaça o teste do celular.

### Operar no dia a dia
- **Assumir**: abre a conversa → "Assumir (silencia a Eme)" → você responde pelo WhatsApp oficial; a Eme não interfere. "Devolver pra Eme" religa a IA.
- **Qualificados**: aba Leads, filtro "Qualificado" - o resumo que a Eme escreveu aparece destacado.
- **Opt-out** (lead mandou PARAR/SAIR/STOP) é definitivo: o sistema recusa recontato mesmo que o lead seja postado de novo pela API.

## Se algo não responder
1. Config: ativa está ON? (OFF = tudo vai pro fluxo antigo do Office)
2. A mensagem veio de um número de USUÁRIO do Office? Então foi (corretamente) pro fluxo interno, não pra Eme.
3. Aba Conversas → transcript: resposta com status `failed` mostra o erro; `dry_run` = modo sombra ligado.
4. Aba Leads → timeline de eventos (`ai_error`, `opener_failed` etc. contam o que travou).
