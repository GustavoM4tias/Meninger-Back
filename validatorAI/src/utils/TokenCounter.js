// src/utils/TokenCounter.js
let globalTokenUsage = 0;

export const TokenCounter = {
    estimateTokens(text) {
        return Math.ceil(text.length / 4); // Aproximado
    },

    addUsage(tokens) {
        globalTokenUsage += tokens;
    },

    getUsage() {
        return globalTokenUsage;
    },

    reset() {
        globalTokenUsage = 0;
    }
};
