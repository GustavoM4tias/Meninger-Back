// services/microsoft/MicrosoftSettingsService.js
//
// Leitura das configurações da integração Microsoft (singleton id=1), com cache
// curto em memória — as listagens do Graph consultam isto a cada chamada e não
// vale ir ao banco toda vez.
//
// O fallback em código só vale quando não há valor gravado. Quem manda é a tela.

import db from '../../models/sequelize/index.js';

const DEFAULTS = {
    list_page_cap: 5000,
    upload_max_mb: 250,
    upload_chunk_mb: 8,
    transcript_app_fallback: true,
    // O vigia de transcrição: procura sozinho depois da reunião, gera a ata e
    // avisa. Ligado por padrão - foi por isso que ele foi feito.
    transcript_auto_report: true,
    transcript_watch_hours: 48,
    meeting_reminder_enabled: true,
    meeting_reminder_minutes: 15,
    outlook_enabled: true,
    outlook_send_enabled: true,
    outlook_page_size: 25,
    // IA da caixa. `outlook_ai_auto_enabled` nasce FALSE de proposito: instalar
    // a feature nao pode fazer e-mail sair sozinho. Ligar e decisao de alguem.
    outlook_ai_enabled: true,
    outlook_ai_auto_enabled: false,
    outlook_ai_triage_size: 40,
};

const CACHE_TTL_MS = 60 * 1000;
let cache = null; // { value, expiresAt }

class MicrosoftSettingsService {

    /** Invalida o cache (chamar depois de salvar pela tela). */
    invalidate() { cache = null; }

    /** Configuração efetiva: o que está gravado, com fallback no default. */
    async get() {
        if (cache && cache.expiresAt > Date.now()) return cache.value;

        let row = null;
        try {
            row = await db.MicrosoftSettings.findByPk(1);
        } catch (err) {
            // Tabela ainda não criada (primeiro boot antes do patch): usa default
            // em vez de derrubar a chamada do Graph.
            console.warn('[MicrosoftSettings] leitura falhou, usando padrões:', err.message);
        }

        const value = { ...DEFAULTS };
        if (row) {
            for (const key of Object.keys(DEFAULTS)) {
                const v = row[key];
                if (v !== null && v !== undefined) value[key] = v;
            }
        }

        cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
    }

    /** Teto de itens por listagem do Graph. */
    async listCap() {
        const { list_page_cap } = await this.get();
        return Number(list_page_cap) || DEFAULTS.list_page_cap;
    }

    /** Limites de upload, já em bytes. */
    async uploadLimits() {
        const s = await this.get();
        const mb = (n, fallback) => (Number(n) || fallback) * 1024 * 1024;
        return {
            maxBytes: mb(s.upload_max_mb, DEFAULTS.upload_max_mb),
            // O Graph exige que cada pedaço (menos o último) seja múltiplo de
            // 320 KiB; arredondamos para baixo em vez de recusar o valor da tela.
            chunkBytes: Math.max(1, Math.floor(mb(s.upload_chunk_mb, DEFAULTS.upload_chunk_mb) / (320 * 1024))) * 320 * 1024,
            maxMb: Number(s.upload_max_mb) || DEFAULTS.upload_max_mb,
        };
    }

    static get DEFAULTS() { return { ...DEFAULTS }; }
}

export default new MicrosoftSettingsService();
export { DEFAULTS as MICROSOFT_SETTINGS_DEFAULTS };
