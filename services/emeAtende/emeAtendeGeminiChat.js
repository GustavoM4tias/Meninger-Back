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
                // TODAS as chamadas da rodada, não só a primeira. O Gemini emite
                // function calls em paralelo ("manda as 3 fotos") e pegar só
                // parts.find() descartava o resto EM SILÊNCIO: o modelo dizia que ia
                // enviar em sequência e chegava uma mídia só.
                const fcs = parts.filter(p => p.functionCall).map(p => p.functionCall);
                if (!fcs.length) {
                    // Rodada que só chamou ferramenta e não escreveu nada: o lead
                    // recebia 3 fotos surgindo do nada, sem uma palavra. Pede a
                    // frase de acompanhamento em vez de mandar mídia muda.
                    if (!text && toolCalls.length) {
                        const comp = await chat.sendMessage(
                            'Escreva agora, em uma ou duas frases curtas, a mensagem que acompanha o que você acabou de enviar. '
                            + 'Não chame nenhuma ferramenta.');
                        const partesComp = comp.response?.candidates?.[0]?.content?.parts || [];
                        const textoComp = partesComp.filter(p => p.text).map(p => p.text).join('').trim();
                        if (textoComp) return { text: textoComp, toolCalls };
                    }
                    return { text, toolCalls };
                }

                const responses = [];
                for (const fc of fcs) {
                    toolCalls.push({ name: fc.name, args: fc.args || {} });
                    let toolResult = { ok: true };
                    if (typeof onTool === 'function') {
                        try { toolResult = (await onTool(fc)) || { ok: true }; }
                        catch (err) { toolResult = { ok: false, error: err?.message }; }
                    }
                    responses.push({ functionResponse: { name: fc.name, response: toolResult } });
                }
                result = await chat.sendMessage(responses);
            }
            const parts = result.response?.candidates?.[0]?.content?.parts || [];
            let text = parts.filter(p => p.text).map(p => p.text).join('').trim();
            // Estourou MAX_TOOL_ROUNDS no meio de uma tool call → sem esta rodada
            // final o retorno seria text:'' e o lead ficaria sem resposta.
            const pendingFc = parts.find(p => p.functionCall)?.functionCall;
            if (!text && pendingFc) {
                const final = await chat.sendMessage([{
                    functionResponse: {
                        name: pendingFc.name,
                        response: { ok: false, error: 'Limite de ferramentas desta rodada atingido — responda o lead em TEXTO com o que você já tem.' },
                    },
                }]);
                const finalParts = final.response?.candidates?.[0]?.content?.parts || [];
                text = finalParts.filter(p => p.text).map(p => p.text).join('').trim();
            }
            return { text, toolCalls };
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
