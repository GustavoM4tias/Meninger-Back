// validatorAI/src/services/MeetingSummaryService.js
// Gera relatório completo de reunião usando o pipeline Gemini já configurado.
import { AIService } from './AIService.js';

// Limite de chars antes de fazer chunking (conservador para caber no contexto + report)
const CHUNK_THRESHOLD = 120_000;
const CHUNK_SIZE      = 80_000;

// ── Prompt principal ──────────────────────────────────────────────────────────

// A ATA é lida por quem NÃO estava na reunião, e é usada para cobrar gente.
// Isso muda o que se pede ao modelo:
//
//   - Cada decisão e cada ação carregam o MINUTO e QUEM falou. Sem âncora não
//     dá para conferir, e ata que não dá para conferir vira boato.
//   - O que ficou no ar tem seção própria (questoes_abertas). Antes isso ou
//     sumia, ou pior: virava "decisão" porque alguém sugeriu e ninguém
//     respondeu.
//   - Responsável só existe se alguém foi nomeado. Deduzir dono de tarefa é o
//     erro mais caro que uma ata comete.
//   - O reconhecimento de fala do Teams erra nome próprio, e a Menin está cheia
//     deles (empreendimento, sigla, sistema). O glossário abaixo faz a correção
//     silenciosa, do mesmo jeito que a Eme faz com a fala do usuário.
function buildPrompt(transcriptText, meta) {
    return `Você é o secretário de atas da Menin Engenharia. Sua ata será lida por
quem NÃO participou da reunião, e vai ser usada para cobrar entregas. Precisão
importa mais do que completude: é melhor uma ata curta e verdadeira do que uma
ata rica e inventada.

METADADOS DA REUNIÃO:
- Assunto: ${meta.subject || 'Não informado'}
- Data: ${meta.date || 'Não informada'}
- Duração: ${meta.durationMin ? meta.durationMin + ' minutos' : 'Não informada'}
- Convidados: ${meta.attendees?.join(', ') || 'Não informados'}

A transcrição vem no formato [minuto] Quem falou: o que falou.

REGRAS DE PRECISÃO (as mais importantes):
1. NÃO INVENTE. Tudo que você escrever precisa estar na transcrição. Se algo foi
   dito pela metade, escreva o que foi dito e marque como incerto - nunca
   complete com o que "provavelmente" era.
2. ÂNCORA. Toda decisão, ação, questão em aberto e ponto de atenção leva o
   "minuto" (o timestamp da fala que a originou) e "quem" (o nome exato como
   aparece na transcrição). Sem âncora, não entra na ata.
3. RESPONSÁVEL SÓ SE NOMEADO. Se ninguém disse quem faz, "responsavel" é null.
   Não deduza pelo cargo, pelo assunto nem por quem falou mais.
4. PRAZO SÓ SE DITO. "Semana que vem" vale como prazo ("semana que vem"); "o
   quanto antes" não é prazo, é null.
5. DECISÃO x IDEIA. Decisão é o que foi FECHADO ("vamos fazer", "fica
   definido", "aprovado"). Sugestão que ninguém respondeu, dúvida sem resposta e
   proposta em discussão vão para "questoes_abertas", NUNCA para "decisoes".
6. NÚMEROS COMO FORAM DITOS. Copie valor e unidade da fala. Não converta, não
   arredonde, não some. Se o número veio confuso na transcrição, marque
   "confianca" como "baixa".
7. QUEM FALOU É A FONTE. Use os nomes que aparecem na transcrição. Não atribua
   fala a convidado que não aparece falando, mesmo que ele estivesse convidado.

VOCABULÁRIO DA CASA (o reconhecimento de fala do Teams erra nome próprio -
corrija em silêncio quando o contexto deixar claro, sem comentar a correção):
empreendimento, VGV, repasse, distrato, permuta, alçada, ficha comercial,
pré-cadastro, reserva, corretor, imobiliária, Sienge, CV CRM, Office, Caixa,
MCMV, INCC, habite-se, RG (registro de incorporação), CEF, boleto, comissão,
Ibitinga, Araçatuba, Birigui, Penápolis, Bady Bassitt.

O QUE FAZER COM CADA CAMPO:
- resumo: 2 a 4 parágrafos, para quem não estava lá. Comece pelo resultado da
  reunião, não pela ordem cronológica.
- pauta: os temas efetivamente discutidos, na ordem em que apareceram.
- decisoes: só o que foi fechado. Se a reunião não fechou nada, devolva [] - é
  informação legítima e comum.
- questoes_abertas: o que ficou no ar. Pergunta sem resposta, ponto adiado,
  divergência não resolvida, proposta esperando alguém. Diga o que falta para
  fechar ("o_que_falta") e de quem se espera ("esperando", null se ninguém foi
  nomeado). ESTA SEÇÃO É TÃO IMPORTANTE QUANTO AS DECISÕES.
- kpis: qualquer número, meta, prazo, percentual ou resultado citado.
- acoes: o que alguém precisa fazer. Prioridade pelo que foi dito na reunião
  (urgência declarada), não pelo seu julgamento.
- checklist: itens concretos a conferir ou entregar, derivados das ações.
- proximos_passos: o combinado sobre a continuidade (próxima reunião, retomada,
  o que acontece antes).
- participantes: só quem efetivamente aparece falando.
- pontos_atencao: risco, problema, atraso ou conflito mencionado.
- sentimento_geral: como a reunião correu, com base no tom das falas.
- tags: 3 a 6 termos que ajudem a achar esta reunião depois.
- duracao_real_min: calcule pelo último timestamp da transcrição.
- confiabilidade: sua avaliação honesta da transcrição. Áudio ruim, muita
  sobreposição de fala ou nomes ilegíveis puxam para baixo, e a ata inteira
  deve ser lida com ressalva.

Responda SOMENTE com JSON válido. Sem markdown, sem texto fora do JSON.

ESTRUTURA OBRIGATÓRIA DO JSON:
{
  "resumo": "2 a 4 parágrafos, começando pelo resultado da reunião",
  "pauta": ["Tema discutido 1", "Tema discutido 2"],
  "decisoes": [
    {
      "texto": "O que ficou decidido, na forma afirmativa",
      "quem": "Quem fechou a decisão (nome da transcrição)",
      "minuto": "00:12:33",
      "confianca": "alta | media | baixa"
    }
  ],
  "questoes_abertas": [
    {
      "questao": "O que ficou sem resposta ou sem fechamento",
      "quem_levantou": "Nome (ou null)",
      "o_que_falta": "O que precisa acontecer para fechar",
      "esperando": "Nome de quem se espera (ou null)",
      "minuto": "00:20:10"
    }
  ],
  "kpis": [
    {
      "nome": "Nome do indicador",
      "valor": "Exatamente como foi dito",
      "referencia": "Meta ou comparativo citado (ou null)",
      "contexto": "O que esse número representa",
      "quem": "Quem citou (ou null)",
      "minuto": "00:08:02",
      "confianca": "alta | media | baixa"
    }
  ],
  "acoes": [
    {
      "tarefa": "O que deve ser feito, começando por um verbo",
      "responsavel": "Nome de quem foi NOMEADO (ou null)",
      "prazo": "Prazo como foi dito (ou null)",
      "prioridade": "alta | media | baixa",
      "quem": "Quem pediu ou assumiu",
      "minuto": "00:31:47"
    }
  ],
  "checklist": [
    { "item": "Item a verificar ou entregar", "responsavel": "Nome (ou null)", "concluido": false }
  ],
  "proximos_passos": ["Próximo passo combinado"],
  "participantes": [
    {
      "nome": "Nome como aparece na transcrição",
      "papel": "Papel percebido (conduziu, apresentou, decidiu, ouviu)",
      "contribuicao": "1 frase sobre o que essa pessoa trouxe"
    }
  ],
  "pontos_atencao": [
    { "ponto": "Risco, problema ou atraso mencionado", "quem": "Nome (ou null)", "minuto": "00:44:12" }
  ],
  "sentimento_geral": "positivo | neutro | negativo | misto",
  "tags": ["tag1", "tag2", "tag3"],
  "duracao_real_min": null,
  "confiabilidade": {
    "nivel": "alta | media | baixa",
    "motivo": "Uma frase - só preencha quando não for alta"
  }
}

TRANSCRIÇÃO:
${transcriptText}`;
}

// Prompt para meta-resumo quando há múltiplos chunks
function buildMetaPrompt(partialReports, meta) {
    const parts = partialReports.map((r, i) => `--- PARTE ${i + 1} ---\n${JSON.stringify(r)}`).join('\n\n');
    return `Você recebeu ${partialReports.length} resumos parciais de uma mesma reunião longa.
Consolide-os em UM ÚNICO relatório final coerente, sem repetições, seguindo exatamente a mesma estrutura JSON.

Metadados: Assunto="${meta.subject}", Data="${meta.date}", Duração="${meta.durationMin} min"
Responda SOMENTE com JSON válido.

ESTRUTURA: {"resumo","pauta","decisoes","questoes_abertas","kpis","acoes","checklist","proximos_passos","participantes","pontos_atencao","sentimento_geral","tags","duracao_real_min","confiabilidade"}

REGRAS DA CONSOLIDAÇÃO:
- Preserve o "minuto" e o "quem" de cada item: são a âncora que permite conferir a ata na transcrição.
- Item repetido entre partes vira UM, com o minuto da PRIMEIRA vez que apareceu.
- Questão aberta numa parte e RESPONDIDA em outra deixa de ser questão aberta e vira decisão, com o minuto da resposta.
- Não invente ligação entre partes. Se duas partes falam de coisas parecidas sem se referirem uma à outra, mantenha separado.
- confiabilidade: use o pior nível entre as partes.

RESUMOS PARCIAIS:
${parts}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function splitIntoChunks(text, size = CHUNK_SIZE) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

function parseJsonResponse(raw) {
    const text = raw.trim();
    // Remove markdown code fences if model returned them despite instructions
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(clean);
}

// ── Exported service ──────────────────────────────────────────────────────────

export class MeetingSummaryService {

    /**
     * Gera o relatório completo de reunião.
     * Usa chunking automático para transcrições longas.
     *
     * @param {string} transcriptText  - Texto plano extraído do VTT (speaker: text)
     * @param {{ subject, date, durationMin, attendees }} meta
     * @returns {{ report: object, tokensUsed: number, model: string }}
     */
    static async summarize(transcriptText, meta) {
        const preferredModels = ['gemini-2.5-pro', 'gemini-2.5-flash'];

        // Transcrição cabe num único prompt
        if (transcriptText.length <= CHUNK_THRESHOLD) {
            const prompt = buildPrompt(transcriptText, meta);
            const result = await AIService.generateResponse(prompt, '', preferredModels);

            if (result.error || !result.response) {
                throw new Error(result.error || 'Gemini não retornou resposta');
            }

            return {
                report: parseJsonResponse(result.response),
                tokensUsed: result.tokensUsed,
                model: result.model,
            };
        }

        // Chunking: transcrição muito longa
        console.log(`[MeetingSummary] Transcrição longa (${transcriptText.length} chars) — usando chunking`);
        const chunks = splitIntoChunks(transcriptText);
        const partials = [];
        let totalTokens = 0;
        let lastModel = preferredModels[0];

        for (let i = 0; i < chunks.length; i++) {
            const prompt = buildPrompt(chunks[i], {
                ...meta,
                subject: `${meta.subject} (parte ${i + 1}/${chunks.length})`,
            });
            const result = await AIService.generateResponse(prompt, '', preferredModels);
            if (result.error || !result.response) throw new Error(result.error || 'Gemini falhou no chunk');
            partials.push(parseJsonResponse(result.response));
            totalTokens += result.tokensUsed;
            lastModel = result.model;
        }

        // Meta-resumo
        const metaPrompt = buildMetaPrompt(partials, meta);
        const metaResult = await AIService.generateResponse(metaPrompt, '', preferredModels);
        if (metaResult.error || !metaResult.response) throw new Error(metaResult.error || 'Meta-resumo falhou');

        return {
            report: parseJsonResponse(metaResult.response),
            tokensUsed: totalTokens + metaResult.tokensUsed,
            model: metaResult.model || lastModel,
        };
    }
}
