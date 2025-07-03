// src/config/ModelManager.js
import dotenv from 'dotenv';
dotenv.config();

export const ModelManager = {
    getLimits() {
        return {
            'gemini-1.5-flash': parseInt(process.env.MAX_TOKENS_FLASH || '8000'),
            'gemini-2.0-flash-exp': parseInt(process.env.MAX_TOKENS_EXP || '28000'),
            'gemini-1.5-pro': parseInt(process.env.MAX_TOKENS_PRO || '1000000'),
            'gemini-2.5-pro': parseInt(process.env.MAX_TOKENS_PRO || '1000000'),
        };
    },

    selectModel(tokenCount, preferred = null) {
        const limits = this.getLimits();

        if (preferred && limits[preferred] && tokenCount <= limits[preferred]) {
            return preferred;
        }

        const entries = Object.entries(limits).sort((a, b) => a[1] - b[1]);
        for (const [model, limit] of entries) {
            if (tokenCount <= limit) return model;
        }

        throw new Error('Token count excede todos os modelos disponíveis');
    }
};
