// validatorAI/src/config/geminiClient.js
import { GoogleGenerativeAI } from "@google/generative-ai";

// Lê múltiplas chaves (ou cai para a única)
const keysEnv = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
const keys = keysEnv
    .split(",")
    .map(k => k.trim())
    .filter(Boolean);

if (keys.length === 0) {
    throw new Error("Nenhuma chave Gemini encontrada. Defina GEMINI_API_KEYS ou GEMINI_API_KEY.");
}

// Instancia um client por chave
const clients = keys.map(k => new GoogleGenerativeAI(k));

// Round-robin + cooldown por chave
let cursor = 0;
const cooldownUntil = new Array(keys.length).fill(0);
// Ajuste fino: tempo de quarentena de uma chave após limite/quota
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

function now() {
    return Date.now();
}

/**
 * Retorna o próximo client disponível (fora de cooldown), avançando o cursor.
 * Se todas estiverem em cooldown, entrega a do cursor atual (melhor do que travar).
 */
export function nextClient() {
    const t = now();
    for (let i = 0; i < clients.length; i++) {
        const idx = (cursor + i) % clients.length;
        if (cooldownUntil[idx] <= t) {
            cursor = (idx + 1) % clients.length;
            return { client: clients[idx], index: idx };
        }
    }
    // fallback: todas em cooldown, devolve cursor (pode ainda funcionar)
    const idx = cursor;
    cursor = (cursor + 1) % clients.length;
    return { client: clients[idx], index: idx };
}

/** Coloca a chave em cooldown por ms (padrão 5 min) */
export function markCooldown(index, ms = DEFAULT_COOLDOWN_MS) {
    cooldownUntil[index] = now() + ms;
}

/** Exponho para loops de tentativa */
export const keyCount = clients.length;

/** Opcional: util para debug/observabilidade */
export function getKeyStatus() {
    const t = now();
    return cooldownUntil.map((until, i) => ({
        index: i,
        inCooldown: until > t,
        cooldownMsLeft: Math.max(0, until - t)
    }));
}
