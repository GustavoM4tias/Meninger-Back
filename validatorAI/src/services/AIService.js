// src/services/AIService.js
import genAI from '../config/geminiClient.js';
import { TokenUsage } from '../utils/db.js';
import { ModelManager } from '../config/ModelManager.js';
import dotenv from 'dotenv';
dotenv.config();

export class AIService {
  static async generateResponse(systemPrompt, userMessage, preferredModel = null) {
    const fullPrompt = `${systemPrompt}\n\nPergunta/Mensagem do usuário:\n${userMessage}`;

    const defaultModel = preferredModel || process.env.DEFAULT_MODEL;
    const modelToUse = ModelManager.selectModel(0, defaultModel); // pode ignorar tokens aqui

    const aiModel = genAI.getGenerativeModel({ model: modelToUse });
    const result = await aiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }]
    });

    const responseText = (await result.response.text()).trim();

    // Usa os metadados oficiais do Gemini para token counting
    const usage = result.response.usageMetadata || {};
    const promptTokens = usage.promptTokenCount ?? 0;
    const responseTokens = usage.candidatesTokenCount ?? 0;
    const totalTokens = usage.totalTokenCount ?? (promptTokens + responseTokens);

    // Salva no banco
    await TokenUsage.create({
      model: modelToUse,
      tokensUsed: totalTokens,
      context: 'document'
    });

    return {
      response: responseText,
      tokensUsed: totalTokens,
      model: modelToUse
    };
  }
}
