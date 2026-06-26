// services/meta/MetaAppConfigService.js
//
// Singleton (id = 1) das credenciais de App do Meta, COMPARTILHADAS entre o
// WhatsApp e o Marketing/Lead Ads (mesmo App na Meta → mesmo App Secret).
//
// Mesmo padrão do MarketingConfigService:
//  - App Secret criptografado (AES-256-CBC, chave do JWT_SECRET)
//  - cache de 30s
//  - os helpers retornam null quando a central ainda não tem valor; aí o
//    chamador cai pra config própria do módulo + .env (migração sem regressão).

import db from '../../models/sequelize/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

const SINGLETON_ID = 1;
const CACHE_TTL_MS = 30_000;

let _cache = null;
let _cacheAt = 0;

async function loadRow() {
    let row = await db.MetaAppConfig.findByPk(SINGLETON_ID);
    if (!row) row = await db.MetaAppConfig.create({ id: SINGLETON_ID });
    return row;
}

function rowToConfig(row, { withSecrets = false } = {}) {
    if (!row) return null;
    const base = {
        id: row.id,
        meta_app_id: row.meta_app_id,
        meta_graph_api_version: row.meta_graph_api_version,
        has_meta_app_secret: !!row.meta_app_secret_enc,
        last_test_at: row.last_test_at,
        last_test_ok: row.last_test_ok,
        last_test_error: row.last_test_error,
        updated_at: row.updated_at,
    };
    if (!withSecrets) return base;
    return {
        ...base,
        meta_app_secret: row.meta_app_secret_enc ? decrypt(row.meta_app_secret_enc) : null,
    };
}

async function getConfig({ withSecrets = false, useCache = true } = {}) {
    if (useCache && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
        return withSecrets ? _cache.full : _cache.publicCfg;
    }
    try {
        const row = await loadRow();
        const full = rowToConfig(row, { withSecrets: true });
        const publicCfg = rowToConfig(row, { withSecrets: false });
        _cache = { full, publicCfg };
        _cacheAt = Date.now();
        return withSecrets ? full : publicCfg;
    } catch (err) {
        console.error('[meta-app-config] erro ao ler DB:', err.message);
        return null;
    }
}

function invalidateCache() { _cache = null; _cacheAt = 0; }

// ── Helpers com fallback (null = central vazia → usar config própria + env) ──
async function getAppSecret() {
    try { const c = await getConfig({ withSecrets: true }); return c?.meta_app_secret || null; }
    catch { return null; }
}
async function getAppId() {
    try { const c = await getConfig(); return c?.meta_app_id || null; }
    catch { return null; }
}
async function getGraphVersion() {
    try { const c = await getConfig(); return c?.meta_graph_api_version || null; }
    catch { return null; }
}

/**
 * Atualiza a config. Para o secret:
 *   - null/undefined/'': mantém o atual
 *   - '__CLEAR__': remove
 *   - qualquer outra string: criptografa e grava
 */
async function updateConfig(patch = {}) {
    const row = await loadRow();

    if (patch.meta_app_id !== undefined && patch.meta_app_id !== null) {
        row.meta_app_id = patch.meta_app_id;
    }
    if (patch.meta_graph_api_version) {
        row.meta_graph_api_version = patch.meta_graph_api_version;
    }

    const v = patch.meta_app_secret;
    if (!(v === undefined || v === null || v === '')) {
        row.meta_app_secret_enc = v === '__CLEAR__' ? null : encrypt(String(v));
    }

    await row.save();
    invalidateCache();
    return rowToConfig(row, { withSecrets: false });
}

async function recordTest({ ok, error = null }) {
    try {
        const row = await loadRow();
        row.last_test_at = new Date();
        row.last_test_ok = !!ok;
        row.last_test_error = ok ? null : (error || 'unknown');
        await row.save();
        invalidateCache();
        return rowToConfig(row, { withSecrets: false });
    } catch (err) {
        console.error('[meta-app-config] recordTest falhou:', err.message);
        return null;
    }
}

export default {
    getConfig, updateConfig, recordTest, invalidateCache,
    getAppSecret, getAppId, getGraphVersion,
};
