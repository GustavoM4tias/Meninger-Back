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
  static async generateResponse(systemPrompt, userMessage, preferredModels) {
    const fullPrompt = `${systemPrompt}\n\nPergunta/Mensagem do usuário:\n${userMessage}`;

    const envModels = (process.env.GEMINI_MODELS || '')
      .split(',').map(m => m.trim()).filter(Boolean);
    // ordem: preferidos → .env → padrão (2.5-pro, 2.5-flash) 
    const modelsToTry = [
      ...(Array.isArray(preferredModels) ? preferredModels : []),
      ...envModels,
    ].filter((v, i, a) => v && a.indexOf(v) === i); // únicos e definidos

    let lastErr;

    for (const modelToUse of modelsToTry) {
      const maxAttempts = Math.max(1, getKeyCount()); // tenta 1x por chave disponível
      let attempts = 0;
      while (attempts < maxAttempts) {
        const { client, index } = nextClient();
        if (!client) {
          console.warn(`Todas as chaves estão em cooldown para ${modelToUse}; alternando para próximo modelo.`);
          break; // sai do loop de chaves e tenta próximo modelo
        }
        attempts++;

        try {
          const aiModel = client.getGenerativeModel({ model: modelToUse, responseSchema: "application/json" });
          const result = await aiModel.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }]
          });

          const responseText = (await result.response.text()).trim();
          const usage = result.response.usageMetadata || {};
          const totalTokens = usage.totalTokenCount ?? 0;

          await TokenUsage.create({
            model: modelToUse,
            tokensUsed: totalTokens,
            context: "document",
            providerMeta: JSON.stringify({ provider: "gemini", keyIndex: index })
          });

          return { response: responseText, tokensUsed: totalTokens, model: modelToUse, keyIndex: index };

        } catch (err) {
          lastErr = err;
          const code = err?.status ?? err?.code ?? err?.response?.status;
          const msg = err?.message || String(err);

          console.error(`[Debug] Tentativa ${attempts}/${maxAttempts} para modelo ${modelToUse}`);

          // 404: modelo inexistente/indisponível → fatal só para ESTE modelo: sai do loop de chaves e vai para o próximo modelo
          if (code === 404) {
            console.warn(`Pulando modelo ${modelToUse} por 404 (não suportado/não encontrado).`);
            break;
          }

          if (isQuotaOrTransient(err)) {
            markCooldown(index);
            // backoff rápido para reduzir 429 em rajada
            await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 300)));
            continue;
          }

          return {
            response: null,
            tokensUsed: 0,
            model: modelToUse,
            keyIndex: index,
            error: `Erro fatal na chave [${index}] (${modelToUse}): ${msg}`
          };
        }
      }

      // se chegou aqui: todas as chaves desse modelo falharam → tenta próximo modelo
      console.warn(`Todas as chaves falharam para ${modelToUse}, tentando próximo modelo...`);
    }

    // se nenhum modelo respondeu → devolve erro
    return {
      response: null,
      tokensUsed: 0,
      model: modelsToTry[0] || "gemini",
      keyIndex: -1,
      error: `Falha geral: todos os modelos e chaves falharam (${lastErr?.message || "desconhecido"})`
    };
  }
} 