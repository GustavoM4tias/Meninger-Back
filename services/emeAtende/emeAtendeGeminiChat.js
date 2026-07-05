// services/emeAtende/emeAtendeGeminiChat.js
// Chat Gemini não-streaming com function calling e rotação de chaves
// (GEMINI_API_KEYS do .env, mesmas do OfficeChat; retry em 429/500/503).
// Separado do geminiClient (digests) e do OfficeChatService (streaming SSE):
// a Eme Atende precisa de rodada síncrona com tools e resposta única.

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const RETRYABLE = new Set([429, 500, 503]);
const MAX_TOOL_ROUNDS = 4;

function getKeys() {
    return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
        .split(',').map(k => k.trim()).filter(Boolean);
}

export function hasGeminiKey() {
    return getKeys().length > 0;
}

function getModelName() {
    return (process.env.EME_ATENDE_GEMINI_MODEL || 'gemini-2.5-flash').trim();
}

/**
 * @param {object} params
 * @param {string} params.systemPrompt
 * @param {Array}  params.history      - [{role:'user'|'model', parts:[{text}]}]
 * @param {string} params.userMessage
 * @param {Array}  params.functionDeclarations
 * @param {Function} params.onTool     - async ({name, args}) => object
 * @returns {Promise<{text: string, toolCalls: Array}>}
 */
export async function runChat({ systemPrompt, history = [], userMessage, functionDeclarations = [], onTool }) {
    const keys = getKeys();
    if (!keys.length) throw new Error('GEMINI_API_KEY(S) não configurada(s).');

    let lastErr = null;
    for (let k = 0; k < keys.length; k++) {
        try {
            const genAI = new GoogleGenerativeAI(keys[k]);
            const model = genAI.getGenerativeModel({
                model: getModelName(),
                systemInstruction: systemPrompt,
                ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
            });
            const chat = model.startChat({ history });

            let result = await chat.sendMessage(userMessage);
            const toolCalls = [];
            let rounds = 0;

            while (rounds++ < MAX_TOOL_ROUNDS) {
                const parts = result.response?.candidates?.[0]?.content?.parts || [];
                const text = parts.filter(p => p.text).map(p => p.text).join('').trim();
                const fc = parts.find(p => p.functionCall)?.functionCall;
                if (!fc) return { text, toolCalls };

                toolCalls.push({ name: fc.name, args: fc.args || {} });
                let toolResult = { ok: true };
                if (typeof onTool === 'function') {
                    try { toolResult = (await onTool(fc)) || { ok: true }; }
                    catch (err) { toolResult = { ok: false, error: err?.message }; }
                }
                result = await chat.sendMessage([
                    { functionResponse: { name: fc.name, response: toolResult } },
                ]);
            }
            const parts = result.response?.candidates?.[0]?.content?.parts || [];
            return { text: parts.filter(p => p.text).map(p => p.text).join('').trim(), toolCalls };
        } catch (err) {
            lastErr = err;
            const status = err?.status || err?.response?.status;
            if (RETRYABLE.has(status) && k < keys.length - 1) {
                console.warn(`[eme-atende/gemini] ${status} na chave ${k} - tentando próxima`);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}
