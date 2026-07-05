// services/emeAtende/EmeAtendeSettingsService.js
// Singleton eme_atende_settings (id=1) com cache 30s. O canal WhatsApp (número/token)
// é o do Office (whatsapp_configs) - aqui só as flags do produto Eme Atende.

import db from '../../models/sequelize/index.js';

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
    };
    _cache = { at: now, cfg };
    return cfg;
}

async function updateConfig(payload = {}) {
    let row = await db.EmeAtendeSetting.findByPk(1);
    if (!row) row = await db.EmeAtendeSetting.create({ id: 1 });
    const update = {};
    for (const k of ['active', 'dry_run', 'debounce_seconds', 'max_ai_messages']) {
        if (payload[k] !== undefined) update[k] = payload[k];
    }
    await row.update(update);
    invalidate();
    return getConfig();
}

export default { getConfig, updateConfig, invalidate };
