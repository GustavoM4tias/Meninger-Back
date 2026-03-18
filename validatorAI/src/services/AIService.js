// src/services/AIService.js
import { nextClient, markCooldown, getKeyCount } from '../config/geminiClient.js';
import { TokenUsage } from '../utils/db.js';
import dotenv from 'dotenv';
dotenv.config();

function isQuotaOrTransient(err) {
  const code = err?.status ?? err?.code ?? err?.response?.status;
  // 403 pode ser billing/disable (não transiente) ou quota (às vezes apresentado como 403).
  // Se quiser ser mais estrito, deixe só 429/500/502/503 como transientes:
  return code === 429 || code === 503 || code === 500 || code === 502;
}

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
      const maxAttempts = Math.max(1, getKeyCount());
      let attempts = 0;
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
          const code = err?.status ?? err?.code ?? err?.response?.status;
          const msg = err?.message || String(err);

          console.error(`[Debug] Tentativa ${attempts}/${maxAttempts} para modelo ${modelToUse}`);

          if (code === 404) {
            console.warn(`Pulando modelo ${modelToUse} por 404 (não suportado/não encontrado).`);
            break;
          }

          if (isQuotaOrTransient(err)) {
            markCooldown(index);
            await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 300)));
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
} 