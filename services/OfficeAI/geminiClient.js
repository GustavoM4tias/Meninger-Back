// services/OfficeAI/geminiClient.js
//
// Client Gemini compartilhado para tarefas FORA do chat (digests, embeddings,
// extração de grafo). Mesma rotação de chave do OfficeChatService, isolado para
// reuso por academyDigestService / academyRetrievalService. Degrada com graça:
// sem chave → retorna null (o caller cai para keyword/sem-digest).

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

// text-embedding-004 saiu do ar em 2026 (404 em embedContent - medido em
// 11/09/2026, o Academy estava com 0 de 55 artigos vetorizados por causa
// disso). gemini-embedding-001 é o estável; pedimos 768 dimensões
// (outputDimensionality) para continuar cabendo na coluna vector(768) do
// Academy e nos vetores já guardados. Troca por env quando o Google mudar de
// novo - e ao trocar, reindexe (Cérebro > Recuperação) e republique os
// artigos: vetor de modelo diferente não se compara.
export const EMBEDDING_MODEL = (process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001').trim();
export const EMBEDDING_DIM = Number(process.env.GEMINI_EMBEDDING_DIM) > 0 ? Number(process.env.GEMINI_EMBEDDING_DIM) : 768;

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
            // REST direto: o SDK instalado não expõe outputDimensionality, e sem
            // ele o gemini-embedding-001 devolve 3072 floats.
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(keys[k])}`;
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: `models/${EMBEDDING_MODEL}`,
                    content: { parts: [{ text: input }] },
                    taskType,
                    outputDimensionality: EMBEDDING_DIM,
                }),
            });
            if (!resp.ok) {
                const err = new Error(`embedContent ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
                err.status = resp.status;
                throw err;
            }
            const values = (await resp.json())?.embedding?.values;
            if (!Array.isArray(values) || !values.length) return null;
            // Vetor truncado (MRL) não vem normalizado: normaliza para o cosseno
            // valer o mesmo no JS e no pgvector.
            const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
            return values.map(v => v / norm);
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

/**
 * JSON a partir de uma IMAGEM. Mesma rotação de chave e mesmo modelo barato do
 * generateJson - só acrescenta a parte visual.
 *
 * Nasceu para ler o odômetro na foto do painel: digitar seis dígitos de pé, no
 * estacionamento, é onde o erro entra (e um km errado contamina a
 * quilometragem de todas as viagens seguintes). A leitura é SUGESTÃO: quem
 * confirma é a pessoa, e a regra de consistência valida depois.
 *
 * @param {string} prompt
 * @param {{ data: string, mimeType: string }} imagem  data = base64 puro (sem data:)
 */
export async function generateJsonFromImage(prompt, imagem, { maxOutputTokens = 512 } = {}) {
    if (!hasGeminiKey()) return null;
    if (!imagem?.data) return null;

    const keys = getKeys();
    for (let k = 0; k < keys.length; k++) {
        try {
            const model = getClient(k).getGenerativeModel({
                model: getCheapModel(),
                generationConfig: {
                    responseMimeType: 'application/json',
                    maxOutputTokens,
                    temperature: 0,   // leitura de número não é tarefa criativa
                    thinkingConfig: { thinkingBudget: 0 },
                },
            });
            const res = await model.generateContent([
                { inlineData: { data: imagem.data, mimeType: imagem.mimeType || 'image/jpeg' } },
                { text: prompt },
            ]);
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
            console.warn('[geminiClient.generateJsonFromImage]', err?.message);
            return null;
        }
    }
    return null;
}
