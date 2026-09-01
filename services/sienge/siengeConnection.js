// services/sienge/siengeConnection.js
//
// A CONEXÃO com o Sienge, resolvida em um lugar só.
//
// Três portas, um cadastro:
//   1. arquivo de backup   → download do .dmpc.gz + md5 (HTTP Basic)
//   2. Postgres do espelho → restore blue-green e leitura das telas
//   3. API REST            → integrações do dia a dia (lib/apiSienge.js)
//
// Precedência, campo a campo: TABELA (tela) → env var → padrão do código. Campo
// vazio na tabela não é "apagado", é "não configurado aqui" - e aí a env var
// continua valendo. É o que permite ligar isto em produção sem tocar em nenhuma
// variável de ambiente.
//
// Senhas nunca trafegam para a tela: `getConnection()` devolve selos `has_*`, e
// só quem chama com `{ withSecrets: true }` (o pipeline, dentro do servidor)
// recebe o valor decifrado.

import db from '../../models/sequelize/index.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

const SINGLETON_ID = 1;

// A carga lê isto várias vezes por rodada (download, restore, validação). 30 s
// é curto o bastante para "salvar na tela e disparar" já usar o valor novo, e
// longo o bastante para não bater no banco a cada passo.
const CACHE_TTL_MS = 30_000;

let _cache = null;
let _cacheAt = 0;

// Painel de nuvem guarda o que foi COLADO: aspas em volta e espaço no fim viram
// parte da senha e a API responde 401. Mesma limpeza do lib/apiSienge.js.
const clean = (v) => String(v ?? '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();

/** Piso: o que já vale hoje em produção, via painel da nuvem. */
function envFallback() {
    const database = clean(process.env.SIENGE_PG_DATABASE) || 'sie214801';
    return {
        backup_url:      clean(process.env.SIENGE_BACKUP_URL) || null,
        backup_md5_url:  clean(process.env.SIENGE_BACKUP_MD5_URL) || null,
        backup_user:     clean(process.env.SIENGE_BACKUP_USER) || null,
        backup_password: clean(process.env.SIENGE_BACKUP_PASSWORD) || null,

        pg_url:              clean(process.env.SIENGE_PG_URL) || null,
        pg_database:         database,
        pg_staging_database: clean(process.env.SIENGE_PG_STAGING_DATABASE) || `${database}_staging`,
        pg_read_url:         clean(process.env.SIENGE_PG_RESTORE_URL) || null,

        api_base_url: clean(process.env.SIENGE_API_BASE_URL) || null,
        api_user:     clean(process.env.SIENGE_API_USER) || null,
        api_password: clean(process.env.SIENGE_API_PASSWORD) || null,

        auto_restore_enabled: process.env.ENABLE_SIENGE_AUTO_RESTORE !== 'false',
        download_max_attempts: Number(process.env.SIENGE_DOWNLOAD_MAX_ATTEMPTS) || 3,
        timezone: clean(process.env.SIENGE_BACKUP_TZ) || 'America/Sao_Paulo',
        read_pool_max: Number(process.env.SIENGE_READ_POOL_MAX) || 4,
        read_statement_timeout_ms: Number(process.env.SIENGE_READ_STATEMENT_TIMEOUT_MS) || 60_000,
    };
}

/**
 * A linha nasce com os valores de OPERAÇÃO que já estão valendo no ambiente.
 *
 * Endereço e senha ficam vazios de propósito (vazio = "use a env var"), mas
 * booleano e número não têm esse estado: a coluna é NOT NULL, então o default do
 * modelo passaria a mandar assim que a linha existisse. Semear com o env é o que
 * garante que criar a linha não muda o comportamento de ninguém - quem estivesse
 * com ENABLE_SIENGE_AUTO_RESTORE=false continuaria com o restore desligado.
 */
function envOperationalDefaults() {
    const env = envFallback();
    return {
        auto_restore_enabled: env.auto_restore_enabled,
        download_max_attempts: env.download_max_attempts,
        timezone: env.timezone,
        read_pool_max: env.read_pool_max,
        read_statement_timeout_ms: env.read_statement_timeout_ms,
    };
}

async function loadRow() {
    const [row] = await db.SiengeConnectionSettings.findOrCreate({
        where: { id: SINGLETON_ID },
        defaults: { id: SINGLETON_ID, ...envOperationalDefaults() },
    });
    return row;
}

/**
 * Junta a linha com o piso das env vars.
 *
 * Regra: só o valor PREENCHIDO na tabela vence. Booleano e número têm default
 * NOT NULL na tabela, então nesses a tabela manda de fato assim que a linha
 * existe - por isso o seed nasce com os mesmos valores que o código usava.
 */
function merge(row, { withSecrets }) {
    const env = envFallback();
    const pick = (v, fb) => {
        const s = typeof v === 'string' ? v.trim() : v;
        return (s === null || s === undefined || s === '') ? fb : s;
    };

    const database = pick(row?.pg_database, env.pg_database);

    const secret = (col, fb) => {
        const enc = row?.[col];
        if (!enc) return fb;
        return decrypt(enc) ?? fb;
    };

    const base = {
        id: row?.id ?? null,

        backup_url:     pick(row?.backup_url, env.backup_url),
        backup_md5_url: pick(row?.backup_md5_url, env.backup_md5_url),
        backup_user:    pick(row?.backup_user, env.backup_user),

        pg_database:         database,
        pg_staging_database: pick(row?.pg_staging_database, null) || `${database}_staging`,

        api_base_url: pick(row?.api_base_url, env.api_base_url),
        api_user:     pick(row?.api_user, env.api_user),

        auto_restore_enabled: row ? !!row.auto_restore_enabled : env.auto_restore_enabled,
        download_max_attempts: Number(row?.download_max_attempts) || env.download_max_attempts,
        timezone: pick(row?.timezone, env.timezone),
        read_pool_max: Number(row?.read_pool_max) || env.read_pool_max,
        read_statement_timeout_ms: Number(row?.read_statement_timeout_ms) || env.read_statement_timeout_ms,

        last_test_at: row?.last_test_at ?? null,
        last_test_ok: row?.last_test_ok ?? null,
        last_test_detail: row?.last_test_detail ?? null,
        updated_at: row?.updated_at ?? null,

        // Selos para a tela: dizem se o segredo existe, sem nunca revelar o
        // valor. `from_env` diz de ONDE ele vem - é a diferença entre "está
        // configurado aqui" e "ainda depende do painel da nuvem".
        has_backup_password: !!(row?.backup_password_enc || env.backup_password),
        has_pg_url:          !!(row?.pg_url_enc || env.pg_url),
        has_pg_read_url:     !!(row?.pg_read_url_enc || env.pg_read_url),
        has_api_password:    !!(row?.api_password_enc || env.api_password),

        from_env: {
            backup_url:      !row?.backup_url && !!env.backup_url,
            backup_md5_url:  !row?.backup_md5_url && !!env.backup_md5_url,
            backup_user:     !row?.backup_user && !!env.backup_user,
            backup_password: !row?.backup_password_enc && !!env.backup_password,
            pg_url:          !row?.pg_url_enc && !!env.pg_url,
            pg_read_url:     !row?.pg_read_url_enc && !!env.pg_read_url,
            pg_database:     !row?.pg_database && !!env.pg_database,
            api_base_url:    !row?.api_base_url && !!env.api_base_url,
            api_user:        !row?.api_user && !!env.api_user,
            api_password:    !row?.api_password_enc && !!env.api_password,
        },
    };

    if (!withSecrets) return base;
    return {
        ...base,
        backup_password: secret('backup_password_enc', env.backup_password),
        pg_url:          secret('pg_url_enc', env.pg_url),
        pg_read_url:     secret('pg_read_url_enc', env.pg_read_url),
        api_password:    secret('api_password_enc', env.api_password),
    };
}

/**
 * A conexão em vigor.
 *
 * Banco fora do ar não pode derrubar a carga nem a API: cai no piso das env
 * vars, que é exatamente o comportamento anterior a esta tabela.
 */
export async function getConnection({ withSecrets = false, useCache = true } = {}) {
    if (useCache && _cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
        return withSecrets ? _cache.full : _cache.publicCfg;
    }
    try {
        const row = await loadRow();
        const full = merge(row, { withSecrets: true });
        const publicCfg = merge(row, { withSecrets: false });
        _cache = { full, publicCfg };
        _cacheAt = Date.now();
        return withSecrets ? full : publicCfg;
    } catch (err) {
        console.warn('[siengeConnection] caindo no piso das env vars:', err.message);
        return merge(null, { withSecrets });
    }
}

export function invalidateConnectionCache() { _cache = null; _cacheAt = 0; }

/** Campos de texto que a tela edita direto. */
const DIRECT = {
    backup_url:          (v) => clean(v) || null,
    backup_md5_url:      (v) => clean(v) || null,
    backup_user:         (v) => clean(v).slice(0, 180) || null,
    pg_database:         (v) => clean(v).slice(0, 63) || null,
    pg_staging_database: (v) => clean(v).slice(0, 63) || null,
    api_base_url:        (v) => clean(v) || null,
    api_user:            (v) => clean(v).slice(0, 180) || null,
    timezone:            (v) => clean(v).slice(0, 64) || 'America/Sao_Paulo',
};

const NUMERIC = {
    download_max_attempts:     { min: 1, max: 10, fallback: 3 },
    read_pool_max:             { min: 1, max: 20, fallback: 4 },
    read_statement_timeout_ms: { min: 5_000, max: 600_000, fallback: 60_000 },
};

const SECRETS = {
    backup_password: 'backup_password_enc',
    pg_url:          'pg_url_enc',
    pg_read_url:     'pg_read_url_enc',
    api_password:    'api_password_enc',
};

function clampInt(v, { min, max, fallback }) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Nome de database é interpolado em CREATE/DROP/RENAME - valide antes de gravar. */
function assertDbName(name, label) {
    if (!name) return;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
        throw new Error(`${label} inválido: use letras, números e _ começando por letra.`);
    }
}

function assertUrl(value, label, protocols) {
    if (!value) return;
    let u;
    try { u = new URL(value); } catch { throw new Error(`${label}: endereço inválido.`); }
    if (!protocols.includes(u.protocol)) {
        throw new Error(`${label}: esperado ${protocols.join(' ou ')}, veio ${u.protocol}`);
    }
}

/**
 * Grava o que veio da tela.
 *
 * Segredo: `undefined`/`null`/`''` MANTÉM o valor atual (a tela nunca recebe o
 * valor, então não pode reenviá-lo), e a sentinela `__CLEAR__` apaga - que aqui
 * significa "volte a usar a env var". Mesmo contrato do MarketingConfigService.
 */
export async function updateConnection(patch = {}, userId = null) {
    const row = await loadRow();

    for (const [key, sanitize] of Object.entries(DIRECT)) {
        if (patch[key] === undefined) continue;
        row[key] = sanitize(patch[key]);
    }
    assertDbName(row.pg_database, 'Database do espelho');
    assertDbName(row.pg_staging_database, 'Database de staging');
    assertUrl(row.backup_url, 'URL do backup', ['http:', 'https:']);
    assertUrl(row.backup_md5_url, 'URL do md5', ['http:', 'https:']);
    assertUrl(row.api_base_url, 'URL da API REST', ['http:', 'https:']);

    for (const [key, limits] of Object.entries(NUMERIC)) {
        if (patch[key] === undefined) continue;
        row[key] = clampInt(patch[key], limits);
    }

    if (patch.auto_restore_enabled !== undefined) {
        row.auto_restore_enabled = Boolean(patch.auto_restore_enabled);
    }

    for (const [field, col] of Object.entries(SECRETS)) {
        const value = patch[field];
        if (value === undefined || value === null || value === '') continue;
        if (value === '__CLEAR__') { row[col] = null; continue; }
        const raw = clean(value);
        if (field === 'pg_url' || field === 'pg_read_url') {
            assertUrl(raw, field === 'pg_url' ? 'URL do Postgres' : 'URL de leitura do Postgres',
                ['postgres:', 'postgresql:']);
        }
        row[col] = encrypt(raw);
    }

    if (userId) row.updated_by = userId;
    await row.save();
    invalidateConnectionCache();
    return merge(row, { withSecrets: false });
}

export async function recordTest(result) {
    try {
        const row = await loadRow();
        await row.update({
            last_test_at: new Date(),
            last_test_ok: !!result?.ok,
            last_test_detail: result?.checks ?? null,
        });
        invalidateConnectionCache();
    } catch (err) {
        console.warn('[siengeConnection] não gravou o resultado do teste:', err.message);
    }
}

/** Cabeçalho Basic do servidor de backup. */
export async function backupAuthHeader() {
    const cfg = await getConnection({ withSecrets: true });
    return 'Basic ' + Buffer.from(`${cfg.backup_user ?? ''}:${cfg.backup_password ?? ''}`).toString('base64');
}

/**
 * As três URLs do Postgres a partir da URL base:
 *   adminUrl   → database `postgres` (CREATE/DROP/RENAME DATABASE)
 *   targetUrl  → o espelho em produção
 *   stagingUrl → onde o restore acontece antes do swap
 *
 * A URL base pode vir com ou sem database no path; sem, usa `pg_database`.
 */
export async function buildPgUrls() {
    const cfg = await getConnection({ withSecrets: true });
    if (!cfg.pg_url) {
        throw new Error('Conexão do Postgres do Sienge não configurada (aba Configuração da tela Sienge).');
    }

    const u = new URL(cfg.pg_url);
    const hasPath = u.pathname && u.pathname !== '/' && u.pathname !== '';
    const targetDb = hasPath ? u.pathname.replace(/^\//, '') : cfg.pg_database;
    const stagingDb = cfg.pg_staging_database || `${targetDb}_staging`;

    const withDb = (name) => {
        const next = new URL(cfg.pg_url);
        next.pathname = '/' + name;
        return next.toString();
    };

    return {
        adminUrl:   withDb('postgres'),
        targetUrl:  withDb(targetDb),
        stagingUrl: withDb(stagingDb),
        targetDb,
        stagingDb,
    };
}

/** URL de LEITURA do espelho (telas de Custos, Inadimplência, Stand, Eme). */
export async function readConnectionString() {
    const cfg = await getConnection({ withSecrets: true });
    if (cfg.pg_read_url) return cfg.pg_read_url;
    if (!cfg.pg_url) {
        throw new Error('Conexão do Postgres do Sienge não configurada (aba Configuração da tela Sienge).');
    }
    const u = new URL(cfg.pg_url);
    u.pathname = '/' + cfg.pg_database;
    return u.toString();
}

export default {
    getConnection, updateConnection, invalidateConnectionCache, recordTest,
    backupAuthHeader, buildPgUrls, readConnectionString,
};
