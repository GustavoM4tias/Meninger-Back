// services/whatsapp/WhatsAppConfigService.js
//
// Configuração singleton do WhatsApp Cloud API.
// - Os campos sensíveis (access_token, app_secret, webhook_verify_token) são
//   guardados criptografados via utils/encryption.js (AES-256-CBC com chave
//   derivada do JWT_SECRET).
// - getConfig() devolve um objeto com os secrets já descriptografados, mas
//   getPublicConfig() omite os secrets — usado pela UI.

import db from '../../models/sequelize/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

const { WhatsappConfig } = db;

const SINGLETON_ID = 1;

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 30_000;

async function loadRow() {
    let row = await WhatsappConfig.findByPk(SINGLETON_ID);
    if (!row) {
        row = await WhatsappConfig.create({ id: SINGLETON_ID });
    }
    return row;
}

function rowToConfig(row, { withSecrets = false } = {}) {
    if (!row) return null;
    const base = {
        id: row.id,
        business_id: row.business_id,
        waba_id: row.waba_id,
        phone_number_id: row.phone_number_id,
        display_phone: row.display_phone,
        display_name: row.display_name,
        api_version: row.api_version,
        active: row.active,
        dry_run: row.dry_run,
        last_health_at: row.last_health_at,
        last_health_ok: row.last_health_ok,
        last_health_error: row.last_health_error,
        // flags úteis pra UI sem expor secret
        has_access_token: !!row.access_token_enc,
        has_app_secret: !!row.app_secret_enc,
        has_webhook_verify_token: !!row.webhook_verify_token_enc,
    };
    if (!withSecrets) return base;
    return {
        ...base,
        access_token: row.access_token_enc ? decrypt(row.access_token_enc) : null,
        app_secret: row.app_secret_enc ? decrypt(row.app_secret_enc) : null,
        webhook_verify_token: row.webhook_verify_token_enc ? decrypt(row.webhook_verify_token_enc) : null,
    };
}

async function getConfig({ withSecrets = false, useCache = true } = {}) {
    if (useCache && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
        return withSecrets ? _cache.full : _cache.publicCfg;
    }
    const row = await loadRow();
    const full = rowToConfig(row, { withSecrets: true });
    const publicCfg = rowToConfig(row, { withSecrets: false });
    _cache = { full, publicCfg };
    _cacheAt = Date.now();
    return withSecrets ? full : publicCfg;
}

function invalidateCache() {
    _cache = null;
    _cacheAt = 0;
}

/**
 * Atualiza a config. Aceita os mesmos campos do getPublicConfig + os 3 secrets:
 *   { access_token, app_secret, webhook_verify_token }
 * Se um secret for "" ou null, o valor existente é mantido.
 * Se for o sentinel '__CLEAR__', o secret é removido.
 */
async function updateConfig(patch = {}) {
    const row = await loadRow();

    const allowed = [
        'business_id', 'waba_id', 'phone_number_id', 'display_phone', 'display_name',
        'api_version', 'active', 'dry_run',
    ];
    for (const k of allowed) {
        if (patch[k] !== undefined) row[k] = patch[k];
    }

    const setSecret = (col, value) => {
        if (value === undefined || value === null || value === '') return;       // mantém
        if (value === '__CLEAR__') { row[col] = null; return; }
        row[col] = encrypt(String(value));
    };
    setSecret('access_token_enc',         patch.access_token);
    setSecret('app_secret_enc',           patch.app_secret);
    setSecret('webhook_verify_token_enc', patch.webhook_verify_token);

    await row.save();
    invalidateCache();
    return rowToConfig(row, { withSecrets: false });
}

async function recordHealth({ ok, error = null }) {
    const row = await loadRow();
    row.last_health_at = new Date();
    row.last_health_ok = !!ok;
    row.last_health_error = ok ? null : (error || 'unknown');
    await row.save();
    invalidateCache();
    return rowToConfig(row, { withSecrets: false });
}

export default {
    getConfig,
    updateConfig,
    recordHealth,
    invalidateCache,
};
