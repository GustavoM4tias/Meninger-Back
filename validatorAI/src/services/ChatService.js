// src/services/ChatService.js
import { AIService } from './AIService.js';

export class ChatService { 
    static async generic(message, prompt = null, preferredModel = null) {
        const defaultPrompt = `
        Você é um assistente útil e prestativo. 
        Responda de forma clara, concisa e educada.
        `;

        const result = await AIService.generateResponse(prompt || defaultPrompt, message, preferredModel);

        return {
            message,
            response: result.response,
            tokensUsed: result.tokensUsed,
            model: result.model
        };
    }
}
