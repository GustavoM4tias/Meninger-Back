// services/marketing/MarketingConfigService.js
//
// Singleton de configuração da captação (id = 1).
// Mesmo padrão do WhatsAppConfigService:
// - secrets criptografados via utils/encryption.js (AES-256-CBC, chave do JWT_SECRET)
// - cache de 30s pra evitar hit no banco a cada dispatch
// - fallback pra process.env quando a DB ainda não tem valor (migração gradual)

import db from '../../models/sequelize/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import MetaAppConfigService from '../meta/MetaAppConfigService.js';

const SINGLETON_ID = 1;
const CACHE_TTL_MS = 30_000;

let _cache = null;
let _cacheAt = 0;

async function loadRow() {
    let row = await db.MarketingConfig.findByPk(SINGLETON_ID);
    if (!row) row = await db.MarketingConfig.create({ id: SINGLETON_ID });
    return row;
}

function rowToConfig(row, { withSecrets = false } = {}) {
    if (!row) return null;
    const base = {
        id: row.id,
        dry_run: row.dry_run,
        retry_max_attempts: row.retry_max_attempts,
        form_rate_limit_per_min: row.form_rate_limit_per_min,
        cv_leads_endpoint: row.cv_leads_endpoint,
        meta_app_id: row.meta_app_id,
        meta_graph_api_version: row.meta_graph_api_version,
        meta_last_health_at: row.meta_last_health_at,
        meta_last_health_ok: row.meta_last_health_ok,
        meta_last_health_error: row.meta_last_health_error,
        meta_last_health_payload: row.meta_last_health_payload,
        // flags pra UI saber se cada secret está configurado (sem expor o valor)
        has_meta_app_secret:     !!row.meta_app_secret_enc,
        has_meta_verify_token:   !!row.meta_verify_token_enc,
        has_meta_access_token:   !!row.meta_access_token_enc,
        updated_at: row.updated_at,
    };
    if (!withSecrets) return base;
    return {
        ...base,
        meta_app_secret:    row.meta_app_secret_enc    ? decrypt(row.meta_app_secret_enc)    : null,
        meta_verify_token:  row.meta_verify_token_enc  ? decrypt(row.meta_verify_token_enc)  : null,
        meta_access_token:  row.meta_access_token_enc  ? decrypt(row.meta_access_token_enc)  : null,
    };
}

// Fallback ao .env quando a DB falha ou ainda não tem valor pro campo.
function envFallback({ withSecrets }) {
    const base = {
        id: null,
        dry_run: process.env.MARKETING_CAPTURE_DRY_RUN === 'true',
        retry_max_attempts: Number(process.env.MARKETING_DISPATCH_MAX_ATTEMPTS) || 6,
        form_rate_limit_per_min: Number(process.env.MARKETING_FORM_RATE_LIMIT) || 10,
        cv_leads_endpoint: process.env.CV_LEADS_ENDPOINT || '/v1/comercial/leads',
        meta_app_id: process.env.META_APP_ID || '785502081163165',
        meta_graph_api_version: process.env.META_GRAPH_API_VERSION || 'v21.0',
        has_meta_app_secret:     !!process.env.META_APP_SECRET,
        has_meta_verify_token:   !!process.env.META_LEAD_WEBHOOK_VERIFY_TOKEN,
        has_meta_access_token:   !!process.env.META_LEAD_ADS_TOKEN,
        _from_env_fallback: true,
    };
    if (!withSecrets) return base;
    return {
        ...base,
        meta_app_secret:    process.env.META_APP_SECRET || null,
        meta_verify_token:  process.env.META_LEAD_WEBHOOK_VERIFY_TOKEN || null,
        meta_access_token:  process.env.META_LEAD_ADS_TOKEN || null,
    };
}

// Mescla config do banco com fallback ao env por campo (caso o banco tenha
// alguns campos preenchidos e outros não). DB tem prioridade quando há valor.
function mergeWithEnv(cfg, withSecrets) {
    const env = envFallback({ withSecrets });
    const out = { ...env, ...cfg };
    // Para secrets, só usa env se a flag has_X for falsa (DB não tem)
    if (withSecrets) {
        if (cfg?.has_meta_app_secret) out.meta_app_secret = cfg.meta_app_secret;
        else out.meta_app_secret = env.meta_app_secret;
        if (cfg?.has_meta_verify_token) out.meta_verify_token = cfg.meta_verify_token;
        else out.meta_verify_token = env.meta_verify_token;
        if (cfg?.has_meta_access_token) out.meta_access_token = cfg.meta_access_token;
        else out.meta_access_token = env.meta_access_token;
    }
    return out;
}

// Sobrepõe as credenciais de NÍVEL DE APP (app_id, app_secret, versão Graph) com
// a config central compartilhada, quando ela tiver valor. Precedência:
// central > própria (marketing_configs) > .env. Os campos PRÓPRIOS do Marketing
// (access token do System User, verify token do leadgen) ficam intactos.
async function applyCentralAppCreds(cfg, withSecrets) {
    if (!cfg) return cfg;
    try {
        const central = await MetaAppConfigService.getConfig({ withSecrets });
        if (!central) return cfg;
        if (central.meta_app_id) cfg.meta_app_id = central.meta_app_id;
        if (central.meta_graph_api_version) cfg.meta_graph_api_version = central.meta_graph_api_version;
        if (central.has_meta_app_secret) {
            cfg.has_meta_app_secret = true;
            if (withSecrets) cfg.meta_app_secret = central.meta_app_secret;
        }
    } catch { /* central indisponível → mantém os valores próprios */ }
    return cfg;
}

async function getConfig({ withSecrets = false, useCache = true } = {}) {
    if (useCache && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
        return withSecrets ? _cache.full : _cache.publicCfg;
    }
    try {
        const row = await loadRow();
        const fullDb = rowToConfig(row, { withSecrets: true });
        const publicDb = rowToConfig(row, { withSecrets: false });
        const full = mergeWithEnv(fullDb, true);
        const publicCfg = mergeWithEnv(publicDb, false);
        await applyCentralAppCreds(full, true);
        await applyCentralAppCreds(publicCfg, false);
        _cache = { full, publicCfg };
        _cacheAt = Date.now();
        return withSecrets ? full : publicCfg;
    } catch (err) {
        console.error('[marketing-config] erro ao ler DB, usando .env:', err.message);
        return envFallback({ withSecrets });
    }
}

function invalidateCache() { _cache = null; _cacheAt = 0; }

/**
 * Atualiza a config. Para secrets:
 *   - null/undefined/'': mantém o valor atual
 *   - '__CLEAR__': remove o secret
 *   - qualquer outra string: criptografa e grava
 */
async function updateConfig(patch = {}) {
    const row = await loadRow();

    const direct = [
        'dry_run', 'retry_max_attempts', 'form_rate_limit_per_min',
        'cv_leads_endpoint', 'meta_app_id', 'meta_graph_api_version',
    ];
    for (const k of direct) {
        if (patch[k] !== undefined && patch[k] !== null) row[k] = patch[k];
    }

    const setSecret = (col, value) => {
        if (value === undefined || value === null || value === '') return;
        if (value === '__CLEAR__') { row[col] = null; return; }
        row[col] = encrypt(String(value));
    };
    setSecret('meta_app_secret_enc',   patch.meta_app_secret);
    setSecret('meta_verify_token_enc', patch.meta_verify_token);
    setSecret('meta_access_token_enc', patch.meta_access_token);

    await row.save();
    invalidateCache();
    return rowToConfig(row, { withSecrets: false });
}

async function recordMetaHealth({ ok, error = null, payload = null }) {
    try {
        const row = await loadRow();
        row.meta_last_health_at = new Date();
        row.meta_last_health_ok = !!ok;
        row.meta_last_health_error = ok ? null : (error || 'unknown');
        row.meta_last_health_payload = payload;
        await row.save();
        invalidateCache();
        return rowToConfig(row, { withSecrets: false });
    } catch (err) {
        console.error('[marketing-config] recordMetaHealth falhou:', err.message);
        return null;
    }
}

export default { getConfig, updateConfig, recordMetaHealth, invalidateCache };
