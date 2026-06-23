// services/OfficeAI/geminiClient.js
//
// Client Gemini compartilhado para tarefas FORA do chat (digests, embeddings,
// extração de grafo). Mesma rotação de chave do OfficeChatService, isolado para
// reuso por academyDigestService / academyRetrievalService. Degrada com graça:
// sem chave → retorna null (o caller cai para keyword/sem-digest).

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

export const EMBEDDING_MODEL = 'text-embedding-004';
export const EMBEDDING_DIM = 768;

const RETRYABLE = new Set([429, 500, 503]);

function getKeys() {
    return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
        .split(',').map(k => k.trim()).filter(Boolean);
}

export function hasGeminiKey() {
    return getKeys().length > 0;
}

function getClient(keyIndex = 0) {
    const keys = getKeys();
    if (!keys.length) throw new Error('GEMINI_API_KEY(S) não configurada(s).');
    return new GoogleGenerativeAI(keys[keyIndex % keys.length]);
}

// Modelo BARATO dedicado aos digests (NÃO usa o pool do chat, que pode estar
// configurado como 'pro' via GEMINI_MODELS — caro e obrigatoriamente em thinking
// mode). Flash aceita thinkingBudget 0 → JSON direto e barato. Override por
// GEMINI_DIGEST_MODEL se necessário.
function getCheapModel() {
    return (process.env.GEMINI_DIGEST_MODEL || 'gemini-2.5-flash').trim();
}

/**
 * Embedding de um texto → number[768] ou null. Trunca a entrada (embeddings
 * cobram por token de entrada). taskType: RETRIEVAL_DOCUMENT (indexar) ou
 * RETRIEVAL_QUERY (buscar).
 */
export async function embedText(text, { taskType = 'RETRIEVAL_DOCUMENT' } = {}) {
    const input = String(text || '').slice(0, 8000).trim();
    if (!input || !hasGeminiKey()) return null;
    const keys = getKeys();
    for (let k = 0; k < keys.length; k++) {
        try {
            const model = getClient(k).getGenerativeModel({ model: EMBEDDING_MODEL });
            const res = await model.embedContent({ content: { parts: [{ text: input }] }, taskType });
            const values = res?.embedding?.values;
            return Array.isArray(values) && values.length ? values : null;
        } catch (err) {
            const status = err?.status || err?.response?.status;
            if (RETRYABLE.has(status) && k < keys.length - 1) continue;
            console.warn('[geminiClient.embedText]', err?.message);
            return null;
        }
    }
    return null;
}

/**
 * Gera JSON estruturado com modelo barato (Flash). Retorna objeto ou null.
 * Força responseMimeType=application/json; temperatura baixa p/ fidelidade.
 */
export async function generateJson(prompt, { maxOutputTokens = 2048 } = {}) {
    if (!hasGeminiKey()) return null;
    const keys = getKeys();
    for (let k = 0; k < keys.length; k++) {
        try {
            const model = getClient(k).getGenerativeModel({
                model: getCheapModel(),
                generationConfig: {
                    responseMimeType: 'application/json',
                    maxOutputTokens,
                    temperature: 0.1,
                    // Os modelos gemini-2.5-* "pensam" por padrão e consomem o
                    // orçamento de saída → JSON vazio. Desliga o thinking para o
                    // JSON sair direto (e barato).
                    thinkingConfig: { thinkingBudget: 0 },
                },
            });
            const res = await model.generateContent(prompt);
            const txt = res?.response?.text?.() || '';
            if (!txt) return null;
            try { return JSON.parse(txt); }
            catch {
                const m = txt.match(/\{[\s\S]*\}/);
                return m ? JSON.parse(m[0]) : null;
            }
        } catch (err) {
            const status = err?.status || err?.response?.status;
            if (RETRYABLE.has(status) && k < keys.length - 1) continue;
            console.warn('[geminiClient.generateJson]', err?.message);
            return null;
        }
    }
    return null;
}

/** Formata floats como literal pgvector: '[0.1,0.2,...]'. null se vazio. */
export function toPgVector(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    return `[${arr.map(n => Number(n)).join(',')}]`;
}
