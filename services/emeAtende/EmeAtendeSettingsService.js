// services/emeAtende/EmeAtendeSettingsService.js
// Singleton eme_atende_settings (id=1) com cache 30s. O canal WhatsApp (número/token)
// é o do Office (whatsapp_configs) - aqui só as flags do produto Eme Atende.

import db from '../../models/sequelize/index.js';
import { DEFAULT_STANDARDS } from './emeAtendeRules.js';

const CACHE_TTL_MS = 30 * 1000;
let _cache = { at: 0, cfg: null };

function invalidate() {
    _cache = { at: 0, cfg: null };
}

async function getConfig() {
    const now = Date.now();
    if (_cache.cfg && now - _cache.at < CACHE_TTL_MS) return _cache.cfg;
    let row = await db.EmeAtendeSetting.findByPk(1);
    if (!row) row = await db.EmeAtendeSetting.create({ id: 1 });
    const cfg = {
        active: !!row.active,
        dry_run: !!row.dry_run,
        debounce_seconds: row.debounce_seconds ?? 8,
        max_ai_messages: row.max_ai_messages ?? 30,
        test_mode: !!row.test_mode,
        test_phones: Array.isArray(row.test_phones) ? row.test_phones : [],
        validation_level: row.validation_level || 'money_dates',
        // camada GERAL de regras (o fluxo do empreendimento complementa)
        global_persona: row.global_persona || '',
        global_rules: row.global_rules || '',
        standards: { ...DEFAULT_STANDARDS, ...(row.standards || {}) },
    };
    _cache = { at: now, cfg };
    return cfg;
}

async function updateConfig(payload = {}) {
    let row = await db.EmeAtendeSetting.findByPk(1);
    if (!row) row = await db.EmeAtendeSetting.create({ id: 1 });
    const update = {};
    for (const k of ['active', 'dry_run', 'debounce_seconds', 'max_ai_messages',
                     'test_mode', 'validation_level', 'global_persona', 'global_rules']) {
        if (payload[k] !== undefined) update[k] = payload[k];
    }
    if (payload.standards !== undefined) {
        // grava só as chaves conhecidas — evita a tela empurrar lixo pro prompt
        const s = payload.standards || {};
        update.standards = {
            max_sentences: Number(s.max_sentences) || DEFAULT_STANDARDS.max_sentences,
            questions_per_message: Number.isFinite(Number(s.questions_per_message))
                ? Number(s.questions_per_message) : DEFAULT_STANDARDS.questions_per_message,
            emoji: s.emoji || DEFAULT_STANDARDS.emoji,
            formality: s.formality || DEFAULT_STANDARDS.formality,
            always_collect: Array.isArray(s.always_collect) ? s.always_collect.filter(Boolean) : [],
            never_discuss: Array.isArray(s.never_discuss) ? s.never_discuss.filter(Boolean) : [],
        };
    }
    if (payload.test_phones !== undefined) {
        // aceita array ou texto com um número por linha/vírgula
        const raw = Array.isArray(payload.test_phones)
            ? payload.test_phones
            : String(payload.test_phones || '').split(/[\n,;]+/);
        update.test_phones = raw.map(p => String(p || '').trim()).filter(Boolean);
    }
    await row.update(update);
    invalidate();
    return getConfig();
}

export default { getConfig, updateConfig, invalidate };
