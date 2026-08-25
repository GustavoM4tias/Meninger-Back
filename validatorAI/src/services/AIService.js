// src/services/AIService.js
import { nextClient, markCooldown, getKeyCount } from '../config/geminiClient.js';
import { TokenUsage } from '../utils/db.js';
import dotenv from 'dotenv';
dotenv.config();

// Quota e sobrecarga NÃO são a mesma falha e não se resolvem do mesmo jeito:
// 429 é a CHAVE que estourou (precisa esfriar e rodar para outra), 503 é o
// MODELO sobrecarregado (passa em segundos, e esfriar a chave só piora).
// Tratar os dois como "transiente" custou caro: com uma chave só, um 503 do
// gemini-2.5-pro punha a chave em cooldown, o fallback para o flash encontrava
// a mesma chave gelada e a análise morria em 2 segundos - deixando o contrato
// parado em "Analise Contratos" até alguém reparar na mão.
function classificaErro(err) {
  const code = err?.status ?? err?.code ?? err?.response?.status;
  if (code === 429) return 'quota';
  if (code === 500 || code === 502 || code === 503) return 'sobrecarga';
  if (code === 404) return 'modelo';
  return 'fatal';
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Espera entre tentativas no MESMO modelo, crescente.
const ESPERAS_MS = [1000, 4000, 10000];
const TENTATIVAS_MIN = Math.max(1, Number(process.env.GEMINI_MAX_RETRIES || 3));

export class AIService {
  // ── Helpers internos ────────────────────────────────────────────────────────

  static _resolveModels(preferredModels) {
    const envModels = (process.env.GEMINI_MODELS || '')
      .split(',').map(m => m.trim()).filter(Boolean);
    return [
      ...(Array.isArray(preferredModels) ? preferredModels : []),
      ...envModels,
    ].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  static async _runWithRetry(modelsToTry, buildParts, context = "document") {
    let lastErr;

    for (const modelToUse of modelsToTry) {
      // Uma chave só não pode significar uma tentativa só.
      const maxAttempts = Math.max(getKeyCount(), TENTATIVAS_MIN);
      let attempts = 0;
      let sobrecargas = 0;
      while (attempts < maxAttempts) {
        const { client, index } = nextClient();
        if (!client) {
          console.warn(`Todas as chaves estão em cooldown para ${modelToUse}; alternando para próximo modelo.`);
          break;
        }
        attempts++;

        try {
          const aiModel = client.getGenerativeModel({ model: modelToUse });
          const result = await aiModel.generateContent({
            contents: [{ role: "user", parts: buildParts() }],
          });

          const responseText = (await result.response.text()).trim();
          const usage = result.response.usageMetadata || {};
          const totalTokens = usage.totalTokenCount ?? 0;

          await TokenUsage.create({
            model: modelToUse,
            tokensUsed: totalTokens,
            context,
            providerMeta: JSON.stringify({ provider: "gemini", keyIndex: index }),
          });

          return { response: responseText, tokensUsed: totalTokens, model: modelToUse, keyIndex: index };

        } catch (err) {
          lastErr = err;
          const tipo = classificaErro(err);
          const msg = err?.message || String(err);

          console.error(`[Debug] Tentativa ${attempts}/${maxAttempts} para modelo ${modelToUse} (${tipo})`);

          if (tipo === 'modelo') {
            console.warn(`Pulando modelo ${modelToUse} por 404 (não suportado/não encontrado).`);
            break;
          }

          if (tipo === 'quota') {
            // A chave estourou o limite: esfria ELA e roda para a próxima.
            markCooldown(index);
            await esperar(400 + Math.floor(Math.random() * 300));
            continue;
          }

          if (tipo === 'sobrecarga') {
            // O modelo está cheio, a chave está boa: repete com a mesma chave,
            // esperando um pouco mais a cada rodada. Sem cooldown aqui.
            const espera = ESPERAS_MS[Math.min(sobrecargas++, ESPERAS_MS.length - 1)];
            console.warn(`Modelo ${modelToUse} sobrecarregado; nova tentativa em ${espera}ms.`);
            await esperar(espera + Math.floor(Math.random() * 300));
            continue;
          }

          return {
            response: null, tokensUsed: 0, model: modelToUse, keyIndex: index,
            error: `Erro fatal na chave [${index}] (${modelToUse}): ${msg}`,
          };
        }
      }

      console.warn(`Todas as chaves falharam para ${modelToUse}, tentando próximo modelo...`);
    }

    return {
      response: null, tokensUsed: 0,
      model: modelsToTry[0] || "gemini", keyIndex: -1,
      error: `Falha geral: todos os modelos e chaves falharam (${lastErr?.message || "desconhecido"})`,
    };
  }

  // ── Chamada texto → texto (fluxo original) ────────────────────────────────

  static async generateResponse(systemPrompt, userMessage, preferredModels) {
    const fullPrompt = `${systemPrompt}\n\nPergunta/Mensagem do usuário:\n${userMessage}`;
    const modelsToTry = this._resolveModels(preferredModels);
    return this._runWithRetry(
      modelsToTry,
      () => [{ text: fullPrompt }],
      "document"
    );
  }

  // ── Chamada PDF (buffer) → texto  ─────────────────────────────────────────
  // Usado para PDFs escaneados (sem camada de texto).
  // O Gemini processa o PDF como imagem e extrai os dados diretamente.

  static async generateResponseFromPdf(prompt, pdfBuffer, preferredModels) {
    const base64Data = pdfBuffer.toString("base64");
    const modelsToTry = this._resolveModels(preferredModels);
    return this._runWithRetry(
      modelsToTry,
      () => [
        { inlineData: { mimeType: "application/pdf", data: base64Data } },
        { text: prompt },
      ],
      "document_ocr"
    );
  }

  // ── Chamada ÁUDIO (buffer) → texto  ───────────────────────────────────────
  // Usado pela transcrição de reunião presencial gravada no navegador.
  // O caminho antigo dependia da Web Speech API, que só existe no Chrome do
  // desktop: no Safari do iPhone (que é como a diretoria acessa) o recurso
  // simplesmente não existia.

  static async generateResponseFromAudio(prompt, audioBuffer, mimeType, preferredModels) {
    const base64Data = audioBuffer.toString("base64");
    const modelsToTry = this._resolveModels(preferredModels);
    return this._runWithRetry(
      modelsToTry,
      () => [
        { inlineData: { mimeType: mimeType || "audio/webm", data: base64Data } },
        { text: prompt },
      ],
      "audio_transcription"
    );
  }
} 