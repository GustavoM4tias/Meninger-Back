// validatorAI/src/services/MeetingSummaryService.js
// Gera relatório completo de reunião usando o pipeline Gemini já configurado.
import { AIService } from './AIService.js';

// Limite de chars antes de fazer chunking (conservador para caber no contexto + report)
const CHUNK_THRESHOLD = 120_000;
const CHUNK_SIZE      = 80_000;

// ── Prompt principal ──────────────────────────────────────────────────────────

function buildPrompt(transcriptText, meta) {
    return `Você é um analista corporativo especialista em síntese de reuniões. \
Analise a transcrição abaixo e gere um relatório COMPLETO e estruturado em JSON.

METADADOS DA REUNIÃO:
- Assunto: ${meta.subject || 'Não informado'}
- Data: ${meta.date || 'Não informada'}
- Duração: ${meta.durationMin ? meta.durationMin + ' minutos' : 'Não informada'}
- Participantes: ${meta.attendees?.join(', ') || 'Não informados'}

INSTRUÇÕES:
1. Extraia TODOS os dados objetivos presentes na transcrição
2. KPIs = qualquer dado numérico, percentual, meta, resultado ou métrica mencionada
3. Ações: inclua responsável e prazo SOMENTE se explicitamente citados na transcrição
4. Checklist: itens concretos que precisam ser verificados, entregues ou monitorados
5. Se um campo não tiver dados, use array vazio [] ou null
6. Responda SOMENTE com JSON válido. Sem markdown, sem texto fora do JSON.

ESTRUTURA OBRIGATÓRIA DO JSON:
{
  "resumo": "Texto corrido de 3 a 5 parágrafos sobre o que foi discutido, contexto e resultado geral",
  "pauta": ["Tema 1 discutido", "Tema 2 discutido"],
  "decisoes": ["Decisão tomada 1", "Decisão tomada 2"],
  "kpis": [
    {
      "nome": "Nome do indicador",
      "valor": "Valor ou resultado mencionado",
      "referencia": "Meta ou comparativo (ou null)",
      "contexto": "Explicação breve do que representa"
    }
  ],
  "acoes": [
    {
      "tarefa": "Descrição clara do que deve ser feito",
      "responsavel": "Nome do responsável (ou null)",
      "prazo": "Prazo mencionado (ou null)",
      "prioridade": "alta | media | baixa"
    }
  ],
  "checklist": [
    {
      "item": "Item a ser verificado/entregue",
      "responsavel": "Nome (ou null)",
      "concluido": false
    }
  ],
  "proximos_passos": ["Próximo passo 1", "Próximo passo 2"],
  "participantes": [
    {
      "nome": "Nome do participante",
      "papel": "Papel percebido na reunião (facilitador, apresentador, etc.)",
      "contribuicao": "Resumo de 1 frase sobre o que essa pessoa contribuiu"
    }
  ],
  "pontos_atencao": ["Risco, problema ou ponto de atenção mencionado"],
  "sentimento_geral": "positivo | neutro | negativo | misto",
  "tags": ["tag1", "tag2", "tag3"],
  "duracao_real_min": null
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

ESTRUTURA: {"resumo","pauta","decisoes","kpis","acoes","checklist","proximos_passos","participantes","pontos_atencao","sentimento_geral","tags","duracao_real_min"}

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
