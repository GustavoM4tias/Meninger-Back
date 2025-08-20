// src/services/AIService.js
import { nextClient, markCooldown, keyCount } from '../config/geminiClient.js';
import { TokenUsage } from '../utils/db.js';
import { ModelManager } from '../config/ModelManager.js';
import dotenv from 'dotenv';
dotenv.config();

function isQuotaOrTransient(err) {
  const code = err?.status ?? err?.code ?? err?.response?.status;
  // 429: rate/quota; 403 (alguns casos de quota/billing); 503: indisponível
  return code === 429 || code === 503 || code === 403;
}

export class AIService {
  static async generateResponse(systemPrompt, userMessage, preferredModel = null) {
    const fullPrompt = `${systemPrompt}\n\nPergunta/Mensagem do usuário:\n${userMessage}`;
    const defaultModel = preferredModel || process.env.DEFAULT_MODEL;
    const modelToUse = ModelManager.selectModel(0, defaultModel); // pode ignorar tokens aqui

    let lastErr;

    // Tenta no máximo uma vez por chave disponível
    for (let attempt = 0; attempt < keyCount; attempt++) {
      const { client, index } = nextClient();

      try {
        const aiModel = client.getGenerativeModel({ model: modelToUse });
        const result = await aiModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: fullPrompt }] }]
        });

        const responseText = (await result.response.text()).trim();
        const usage = result.response.usageMetadata || {};
        const promptTokens = usage.promptTokenCount ?? 0;
        const responseTokens = usage.candidatesTokenCount ?? 0;
        const totalTokens = usage.totalTokenCount ?? (promptTokens + responseTokens);

        // Loga uso de tokens
        await TokenUsage.create({
          model: modelToUse,
          tokensUsed: totalTokens,
          context: 'document',
          // NÃO salve a chave! Se quiser visibilidade de qual índice funcionou:
          providerMeta: JSON.stringify({ provider: 'gemini', keyIndex: index })
        });

        return {
          response: responseText,
          tokensUsed: totalTokens,
          model: modelToUse,
          keyIndex: index
        };

      } catch (err) {
        lastErr = err;
        if (isQuotaOrTransient(err)) {
          // coloca esta chave em cooldown e tenta a próxima
          markCooldown(index);
          continue;
        }
        // Erro não-transitório: propaga imediatamente
        throw err;
      }
    }

    // Se nenhuma chave funcionou, dispara o último erro capturado
    throw lastErr ?? new Error('Falha ao gerar resposta: todas as chaves falharam.');
  }
}
