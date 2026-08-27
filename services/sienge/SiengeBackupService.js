// services/sienge/SiengeBackupService.js
//
// Pipeline diário de backup do banco Sienge:
//   1. Baixa o .dmpc.gz da API Sienge (Basic Auth) → /tmp local
//   2. Valida MD5 contra /backup/latest/md5
//   3. Descomprime em streaming pro disco local (.dmpc)
//   4. pg_restore contra o Postgres dedicado (Railway) — substitui dados do dia
//      anterior usando --clean --if-exists
//   5. Limpa arquivos temporários (mantém só o registro no banco)
//
// O Sienge usa PostgreSQL por baixo. O .dmpc é dump no formato custom do
// pg_dump (-Fc). Restauramos com pg_restore (binário disponível no container
// via nixpacks.toml).

import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { unlink, mkdir, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import db from '../../models/sequelize/index.js';
import { snapshotCustomViews, applyCustomViews } from './siengeCustomViews.js';
import { probePgRestore } from './pgRestoreBin.js';
import { getSettings } from './siengeBackupSettings.js';
import { clearFreshnessCache, probeMirrorLastChange, brasiliaWallClockToInstant } from './siengeMirrorFreshness.js';
import { withBackupLock, instanceId } from '../../lib/siengeBackupLock.js';

// ── Sienge API ────────────────────────────────────────────────────────────────
const SIENGE_USER     = process.env.SIENGE_BACKUP_USER;
const SIENGE_PASSWORD = process.env.SIENGE_BACKUP_PASSWORD;
const SIENGE_URL      = process.env.SIENGE_BACKUP_URL;
const SIENGE_MD5_URL  = process.env.SIENGE_BACKUP_MD5_URL;

// ── PostgreSQL alvo do restore (Railway) ──────────────────────────────────────
const SIENGE_PG_URL          = process.env.SIENGE_PG_URL;
const SIENGE_PG_DATABASE     = process.env.SIENGE_PG_DATABASE || 'sie214801';
const SIENGE_PG_STAGING_DB   = process.env.SIENGE_PG_STAGING_DATABASE || `${SIENGE_PG_DATABASE}_staging`;
const AUTO_RESTORE_ENABLED   = process.env.ENABLE_SIENGE_AUTO_RESTORE !== 'false';

// Paralelismo e timeout do pg_restore vivem em sienge_backup_settings; as env
// vars continuam existindo só como piso (ver siengeBackupSettings.js).

const TMP_DIR = path.join(tmpdir(), 'sienge-backup');

// Batida do log enquanto a rodada vive. Sem isso não dá pra distinguir uma
// rodada de 20 minutos em andamento de um log zumbi de container morto.
const HEARTBEAT_MS = 60_000;

// Caminho do arquivo de GRANTs reaplicado após cada swap. Opcional: se não
// existir, o stage `applying_grants` é pulado sem falhar.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const GRANTS_SQL_PATH = path.join(__dirname, '..', '..', 'scripts', 'sienge-grants.sql');

// Índices de performance do Office (Custos/Títulos ao vivo) reaplicados após
// cada swap — o restore recria o banco e derruba qualquer índice extra.
const PERF_INDEXES_SQL_PATH = path.join(__dirname, '..', '..', 'scripts', 'sienge-perf-indexes.sql');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function siengeAuthHeader() {
  return 'Basic ' + Buffer.from(`${SIENGE_USER}:${SIENGE_PASSWORD}`).toString('base64');
}

/**
 * Constrói as URLs de conexão a partir de SIENGE_PG_URL:
 *   - adminUrl   : aponta pro database "postgres" (CREATE/DROP/RENAME DATABASE)
 *   - targetUrl  : aponta pro database alvo final (queries, validações)
 *   - stagingUrl : aponta pro database de staging onde o restore acontece
 *
 * SIENGE_PG_URL pode vir com ou sem database no path. Se sem, usa
 * SIENGE_PG_DATABASE como default.
 */
function buildPgUrls() {
  if (!SIENGE_PG_URL) throw new Error('SIENGE_PG_URL não configurada');

  const u = new URL(SIENGE_PG_URL);
  const hasPath = u.pathname && u.pathname !== '/' && u.pathname !== '';
  const targetDb = hasPath ? u.pathname.replace(/^\//, '') : SIENGE_PG_DATABASE;
  const stagingDb = SIENGE_PG_STAGING_DB;

  const admin = new URL(SIENGE_PG_URL);
  admin.pathname = '/postgres';

  const target = new URL(SIENGE_PG_URL);
  target.pathname = '/' + targetDb;

  const staging = new URL(SIENGE_PG_URL);
  staging.pathname = '/' + stagingDb;

  return {
    adminUrl:   admin.toString(),
    targetUrl:  target.toString(),
    stagingUrl: staging.toString(),
    targetDb,
    stagingDb,
  };
}

// Valida o nome do database antes de injetar em SQL (RENAME / DROP / CREATE
// não aceitam parâmetros bindados, então temos que validar e interpolar).
function assertValidDbName(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Nome de database inválido: ${name}`);
  }
}

/**
 * Atualiza o stage do log + registra timing (fecha o anterior, abre o novo).
 * Idempotente: chamar duas vezes com o mesmo stage não duplica.
 */
async function setStage(log, name) {
  const now = new Date().toISOString();
  const timings = { ...(log.stage_timings || {}) };

  // Fecha o stage anterior se ainda aberto
  const prev = log.stage;
  if (prev && timings[prev] && !timings[prev].finished_at) {
    timings[prev].finished_at = now;
  }

  // Abre o novo (se ainda não tem)
  if (!timings[name]) {
    timings[name] = { started_at: now };
  }

  await log.update({ stage: name, stage_timings: timings });
  log.stage = name;
  log.stage_timings = timings;
}

/**
 * Fecha o stage corrente no momento de uma falha, pra UI mostrar quanto durou.
 */
async function closeCurrentStage(log) {
  const timings = { ...(log.stage_timings || {}) };
  const curr = log.stage;
  if (curr && timings[curr] && !timings[curr].finished_at) {
    timings[curr].finished_at = new Date().toISOString();
    await log.update({ stage_timings: timings }).catch(() => {});
  }
}

// ─── Fase 1: download do Sienge + MD5 ─────────────────────────────────────────

async function fetchExpectedMd5() {
  const res = await fetch(SIENGE_MD5_URL, { headers: { Authorization: siengeAuthHeader() } });
  if (!res.ok) throw new Error(`MD5 endpoint retornou ${res.status} ${res.statusText}`);
  const text = (await res.text()).trim();
  return text.split(/\s+/)[0].toLowerCase();
}

function describeFetchError(err) {
  // undici (fetch) costuma jogar TypeError "terminated" sem detalhe.
  // O motivo real fica em err.cause (UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT, etc).
  const code   = err?.cause?.code || err?.code;
  const causeMsg = err?.cause?.message;
  const top      = err?.message || String(err);
  return [top, code && `code=${code}`, causeMsg && `cause=${causeMsg}`].filter(Boolean).join(' | ');
}

function isTransientNetworkError(err) {
  const text = describeFetchError(err).toLowerCase();
  return /terminated|econnreset|etimedout|enotfound|eai_again|und_err|socket hang up|network|fetch failed|other side closed|aborted/i.test(text);
}

async function downloadAndHashOnce(localPath, log) {
  const res = await fetch(SIENGE_URL, {
    headers: {
      Authorization: siengeAuthHeader(),
      'Accept-Encoding': 'identity', // não pede gzip de novo (já vem .gz por content)
      'Connection': 'keep-alive',
    },
  });
  if (!res.ok) throw new Error(`Download Sienge falhou: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Resposta do Sienge sem body');

  // Content-Length, quando o Sienge manda, serve pra UI calcular % progresso
  const contentLength = Number(res.headers.get('content-length')) || null;
  if (contentLength && log) {
    await log.update({ file_size_bytes: contentLength }).catch(() => {});
  }

  const hash = createHash('md5');
  const fileStream = createWriteStream(localPath);
  let bytesAcc = 0;
  let lastFlush = 0;
  const FLUSH_INTERVAL_MS = 2000;

  const hashTransform = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytesAcc += chunk.length;
      if (log) {
        const now = Date.now();
        if (now - lastFlush > FLUSH_INTERVAL_MS) {
          lastFlush = now;
          // fire-and-forget pra não bloquear o stream
          log.update({ bytes_downloaded: bytesAcc }).catch(() => {});
        }
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body), hashTransform, fileStream);

  if (log) await log.update({ bytes_downloaded: bytesAcc }).catch(() => {});

  const stats = await stat(localPath);
  return { md5: hash.digest('hex').toLowerCase(), size: stats.size };
}

async function downloadAndHash(localPath, log) {
  const maxAttempts = Number(process.env.SIENGE_DOWNLOAD_MAX_ATTEMPTS || 3);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (log) await log.update({ download_attempts: attempt }).catch(() => {});
    try {
      if (attempt > 1) {
        console.log(`🔁 [SiengeBackup] Retry download tentativa ${attempt}/${maxAttempts}`);
        if (log) await log.update({ bytes_downloaded: 0 }).catch(() => {});
      }
      return await downloadAndHashOnce(localPath, log);
    } catch (err) {
      lastErr = err;
      const detail = describeFetchError(err);
      console.warn(`⚠️  [SiengeBackup] download tentativa ${attempt}/${maxAttempts} falhou: ${detail}`);
      // Limpa arquivo parcial antes da próxima tentativa
      await unlink(localPath).catch(() => {});

      if (!isTransientNetworkError(err) || attempt === maxAttempts) break;

      // Backoff exponencial: 30s, 2min, 5min (cap)
      const wait = Math.min(30_000 * Math.pow(4, attempt - 1), 5 * 60_000);
      console.log(`⏳ [SiengeBackup] aguardando ${wait / 1000}s antes do próximo retry...`);
      await sleep(wait);
    }
  }
  // Re-lança com mensagem enriquecida
  const finalErr = new Error(`Download Sienge falhou após ${maxAttempts} tentativas: ${describeFetchError(lastErr)}`);
  finalErr.cause = lastErr;
  throw finalErr;
}

// ─── Fase 2: descomprime localmente ───────────────────────────────────────────

async function decompressGzToFile(gzPath, dmpcPath) {
  await pipeline(
    createReadStream(gzPath),
    createGunzip(),
    createWriteStream(dmpcPath),
  );
}

// ─── Fase 3: pg_restore ───────────────────────────────────────────────────────

// Railway distribui cert TLS auto-assinado no Postgres. O driver Node `pg`
// valida a cadeia por default (falha com "self-signed certificate"). O psql
// e o pg_restore com sslmode=require encriptam mas não validam CA — aqui
// fazemos o mesmo via { rejectUnauthorized: false }.
const PG_CLIENT_OPTS = (connectionString) => ({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// ── Helpers de gerenciamento de database (blue-green) ────────────────────────

async function withAdminClient(fn) {
  const { adminUrl } = buildPgUrls();
  const client = new pg.Client(PG_CLIENT_OPTS(adminUrl));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function databaseExists(dbName) {
  return withAdminClient(async (c) => {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    return r.rowCount > 0;
  });
}

/**
 * Força fechamento de conexões num database (necessário antes de DROP/RENAME)
 * e dropa com FORCE. Idempotente: se DB não existir, retorna sem erro.
 */
async function dropDatabaseIfExists(dbName) {
  assertValidDbName(dbName);
  return withAdminClient(async (c) => {
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });
}

async function createDatabase(dbName) {
  assertValidDbName(dbName);
  return withAdminClient(async (c) => {
    await c.query(`CREATE DATABASE "${dbName}"`);
  });
}

/**
 * Dropa os `<target>_old_<timestamp>` deixados para trás.
 *
 * O swapDatabases renomeia o banco de produção pra `_old_<ts>` e só depois
 * dropa. Se a rodada morre entre as duas coisas (container derrubado, deploy),
 * fica um banco de 16 GB órfão ocupando disco — e ninguém limpa, porque o
 * pipeline nunca olhou pra trás. A limpeza roda no começo de cada rodada,
 * quando a trava garante que ninguém mais está mexendo nesses nomes.
 */
async function dropLeftoverOldDatabases(targetDb) {
  assertValidDbName(targetDb);
  const dropped = [];
  await withAdminClient(async (c) => {
    const r = await c.query(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 AND datistemplate = false`,
      [`${targetDb}_old_%`]
    );
    for (const { datname } of r.rows) {
      // Confirma o formato antes de interpolar: só `<target>_old_<dígitos>`.
      if (!new RegExp(`^${targetDb}_old_\\d+$`).test(datname)) continue;
      try {
        await c.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [datname]
        );
        await c.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
        dropped.push(datname);
      } catch (e) {
        console.warn(`[SiengeBackup] não consegui dropar sobra "${datname}": ${e.message}`);
      }
    }
  });
  if (dropped.length) console.log(`[SiengeBackup] sobras removidas: ${dropped.join(', ')}`);
  return dropped;
}

/**
 * Swap atômico: renomeia o database de produção pra um nome temporário, promove
 * o staging pro nome de produção, depois dropa o antigo. Tudo numa única
 * conexão admin pra reduzir janela de inconsistência (<1s típico).
 *
 * Se o DB de produção não existe (primeira execução): só promove staging.
 *
 * Em caso de falha após renomear o atual: tenta rollback (volta o nome
 * original). Se rollback também falhar, registra pra intervenção manual.
 */
async function swapDatabases(currentDb, stagingDb) {
  assertValidDbName(currentDb);
  assertValidDbName(stagingDb);
  const oldDb = `${currentDb}_old_${Date.now()}`;
  assertValidDbName(oldDb);

  return withAdminClient(async (c) => {
    // Termina TODAS as conexões nos 2 DBs (RENAME exige zero conexões)
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname IN ($1, $2) AND pid <> pg_backend_pid()`,
      [currentDb, stagingDb]
    );

    const cur = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [currentDb]);
    let renamedCurrent = false;

    try {
      if (cur.rowCount > 0) {
        await c.query(`ALTER DATABASE "${currentDb}" RENAME TO "${oldDb}"`);
        renamedCurrent = true;
      }
      await c.query(`ALTER DATABASE "${stagingDb}" RENAME TO "${currentDb}"`);
      if (renamedCurrent) {
        await c.query(`DROP DATABASE IF EXISTS "${oldDb}" WITH (FORCE)`);
      }
    } catch (err) {
      if (renamedCurrent) {
        // Rollback: volta o nome original. Se falhar, registra crítico.
        try {
          await c.query(`ALTER DATABASE "${oldDb}" RENAME TO "${currentDb}"`);
          console.error(`[SiengeBackup] swap falhou, rollback OK: ${err.message}`);
        } catch (rbErr) {
          console.error(`[SiengeBackup] !!! CRÍTICO !!! swap falhou E rollback falhou. Database em "${oldDb}", staging em "${stagingDb}". Erro original: ${err.message}. Rollback: ${rbErr.message}`);
        }
      }
      throw err;
    }
  });
}

/**
 * Roda queries de validação contra o database recém-restaurado pra detectar
 * restores corrompidos antes do swap (ex: poucos objetos, banco minúsculo).
 * Se falhar, o staging é descartado e o atual fica intacto.
 */
async function validateStaging(stagingUrl, totals) {
  const client = new pg.Client(PG_CLIENT_OPTS(stagingUrl));
  await client.connect();
  try {
    const r = await client.query(`
      SELECT
        (SELECT count(*) FROM pg_tables   WHERE schemaname='public')::int AS tables,
        (SELECT count(*) FROM pg_indexes  WHERE schemaname='public')::int AS indexes,
        (SELECT count(*) FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = 'public' AND c.contype = 'f')::int AS fks,
        pg_database_size(current_database())::bigint AS bytes,
        pg_size_pretty(pg_database_size(current_database()))     AS size
    `);
    const obs = r.rows[0];
    const errors = [];

    // Limiares conservadores: 90% do esperado pra tolerar pequenas diferenças
    // entre TOC e estado final (algumas categorias do TOC criam vários objetos).
    if (totals?.TABLE_DATA > 0 && obs.tables < totals.TABLE_DATA * 0.9) {
      errors.push(`tabelas=${obs.tables} (esperado ~${totals.TABLE_DATA})`);
    }
    if (totals?.FK_CONSTRAINT > 0 && obs.fks < totals.FK_CONSTRAINT * 0.9) {
      errors.push(`fks=${obs.fks} (esperado ~${totals.FK_CONSTRAINT})`);
    }
    if (Number(obs.bytes) < 100 * 1024 * 1024) {
      errors.push(`banco muito pequeno: ${obs.size}`);
    }
    return { ok: errors.length === 0, errors, observed: obs };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Aplica o arquivo scripts/sienge-grants.sql (se existir) contra o database
 * recém-promovido. Permite reaplicar permissões de usuários sem precisar editar
 * o código.
 *
 * NÃO falha o restore inteiro se der erro aqui (banco já foi promovido).
 */
async function applyGrants(targetUrl) {
  if (!existsSync(GRANTS_SQL_PATH)) {
    return { skipped: true, reason: 'arquivo scripts/sienge-grants.sql não existe' };
  }
  const sql = (await readFile(GRANTS_SQL_PATH, 'utf8')).trim();
  if (!sql) {
    return { skipped: true, reason: 'arquivo de grants vazio' };
  }
  const client = new pg.Client(PG_CLIENT_OPTS(targetUrl));
  await client.connect();
  try {
    await client.query(sql);
    return { skipped: false, statements: sql.split(/;\s*$/m).filter(s => s.trim()).length };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Aplica scripts/sienge-perf-indexes.sql (se existir) contra o database
 * recém-promovido. Diferente do applyGrants, roda statement a statement
 * (best-effort): um índice que falhe não impede os demais. Exportado para o
 * ensure de boot do server (caso o deploy aconteça depois do restore do dia).
 *
 * NÃO falha o restore inteiro se der erro aqui (banco já foi promovido).
 */
export async function applyPerfIndexes(targetUrl) {
  if (!existsSync(PERF_INDEXES_SQL_PATH)) {
    return { skipped: true, reason: 'arquivo scripts/sienge-perf-indexes.sql não existe' };
  }
  const raw = (await readFile(PERF_INDEXES_SQL_PATH, 'utf8')).trim();
  if (!raw) return { skipped: true, reason: 'arquivo de índices vazio' };

  // Remove comentários de linha e divide por ';' — o script só tem statements
  // simples (CREATE INDEX / ANALYZE), sem funções ou strings com ';'.
  const statements = raw
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);

  const client = new pg.Client(PG_CLIENT_OPTS(targetUrl));
  await client.connect();
  const failed = [];
  try {
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (e) {
        failed.push({ stmt: stmt.slice(0, 80), error: e.message });
        console.warn(`[SiengeBackup] perf index falhou (ignorado): ${e.message}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  return { skipped: false, applied: statements.length - failed.length, failed };
}

/** Ensure de boot: aplica os índices no banco de produção atual (fire-and-forget). */
export async function ensurePerfIndexes() {
  const { targetUrl } = buildPgUrls();
  return applyPerfIndexes(targetUrl);
}

/**
 * Roda `pg_restore -l` no dump e categoriza cada item do TOC. Usado pelo
 * frontend pra calcular % de progresso por fase. Devolve os totais — barato
 * (<200ms num dump de 1.5GB).
 */
function parseTocCounts(dmpcPath, pgRestoreBin) {
  const r = spawnSync(pgRestoreBin, ['-l', dmpcPath], {
    stdio: 'pipe',
    maxBuffer: 200 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`pg_restore -l falhou (exit=${r.status}): ${r.stderr?.toString().slice(0, 400)}`);
  }
  const counts = {
    TABLE_DATA: 0, INDEX: 0, CONSTRAINT: 0, FK_CONSTRAINT: 0,
    TRIGGER: 0, SEQUENCE_SET: 0, OTHER: 0, TOTAL: 0,
  };
  for (const raw of r.stdout.toString().split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    // formato: "id; oid id TIPO schema nome owner". Tipos compostos têm 2
    // palavras: "TABLE DATA", "FK CONSTRAINT", "SEQUENCE SET", "DEFAULT ACL"
    const m = /^\d+;\s+\d+\s+\d+\s+([A-Z][A-Z]*(?:\s+[A-Z]+)?)\s/.exec(line);
    if (!m) continue;
    counts.TOTAL++;
    const type = m[1];
    if      (type === 'TABLE DATA')    counts.TABLE_DATA++;
    else if (type === 'INDEX')         counts.INDEX++;
    else if (type === 'FK CONSTRAINT') counts.FK_CONSTRAINT++;
    else if (type === 'CONSTRAINT')    counts.CONSTRAINT++;
    else if (type === 'TRIGGER')       counts.TRIGGER++;
    else if (type === 'SEQUENCE SET')  counts.SEQUENCE_SET++;
    else                                counts.OTHER++;
  }
  return counts;
}

function buildEmptyPhaseProgress(totals) {
  return {
    data:       { done: 0, total: totals.TABLE_DATA    || 0, current: null, started_at: null, finished_at: null },
    index:      { done: 0, total: totals.INDEX         || 0, current: null, started_at: null, finished_at: null },
    constraint: { done: 0, total: totals.CONSTRAINT    || 0, current: null, started_at: null, finished_at: null },
    fk:         { done: 0, total: totals.FK_CONSTRAINT || 0, current: null, started_at: null, finished_at: null },
    trigger:    { done: 0, total: totals.TRIGGER       || 0, current: null, started_at: null, finished_at: null },
  };
}

function runPgRestore(dmpcPath, log, totals, targetUrl, { bin, jobs, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // Sem --clean --if-exists: o staging é virgem (acabou de ser criado).
    // Banco atual de produção fica intocado — substituição acontece via swap
    // atômico depois do restore validar.
    const args = [
      '--no-owner',
      '--no-privileges',
      '--no-acl',
      '--verbose',                       // emite "processing data for table X" → UI
      '--jobs', String(jobs),
      '--dbname', targetUrl,
      dmpcPath,
    ];

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let killed = false;
    let killReason = null;
    let lastFlush = 0;
    const FLUSH_INTERVAL_MS = 2000;

    // Tracking por fase pra UI desenhar barras de progresso
    const phases = buildEmptyPhaseProgress(totals);
    const errors = []; // [{ at, msg }] — usado pra detectar cascata

    const timer = setTimeout(() => {
      killed = true;
      killReason = 'timeout';
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    function markPhase(name, currentName) {
      const ph = phases[name];
      if (!ph) return;
      if (!ph.started_at) ph.started_at = new Date().toISOString();
      ph.done++;
      ph.current = currentName;
      if (ph.total > 0 && ph.done >= ph.total && !ph.finished_at) {
        ph.finished_at = new Date().toISOString();
      }
    }

    function flushLine(rawLine) {
      const line = rawLine.replace(/^pg_restore:\s*/i, '').trim();
      if (!line) return;

      const mData = /^processing data for table\s+"([^"]+)"/i.exec(line);
      if (mData) return markPhase('data', mData[1]);

      // "creating INDEX | FK CONSTRAINT | CONSTRAINT | TRIGGER | SEQUENCE SET"
      const mCreate = /^creating\s+(INDEX|FK CONSTRAINT|CONSTRAINT|TRIGGER|SEQUENCE SET)\s+"?([^"]+)"?/i.exec(line);
      if (mCreate) {
        const type = mCreate[1].toUpperCase();
        const name = mCreate[2];
        if (type === 'INDEX')         return markPhase('index', name);
        if (type === 'FK CONSTRAINT') return markPhase('fk', name);
        if (type === 'CONSTRAINT')    return markPhase('constraint', name);
        if (type === 'TRIGGER')       return markPhase('trigger', name);
        return; // SEQUENCE SET: silencioso
      }

      if (/^error|^fatal/i.test(line)) {
        const now = Date.now();
        errors.push({ at: now, msg: line });
        // Cascata de erros = proxy derrubou todas as conexões. Aborta pg_restore
        // pra não ficar em loop infinito de "could not execute query".
        if (!killed) {
          const recent = errors.filter(e => now - e.at < 10_000).length;
          if (recent > 50) {
            killed = true;
            killReason = `cascata de ${recent} erros em 10s (provável queda de conexão)`;
            console.error(`[pg_restore] ${killReason}. Matando processo...`);
            try { proc.kill('SIGKILL'); } catch {}
          }
        }
      }
    }

    let lineBuffer = '';
    proc.stderr.on('data', chunk => {
      const s = chunk.toString();
      stderr += s;
      if (/error|fatal/i.test(s)) {
        console.log('[pg_restore]', s.trim().slice(0, 400));
      }
      lineBuffer += s;
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) >= 0) {
        flushLine(lineBuffer.slice(0, nl));
        lineBuffer = lineBuffer.slice(nl + 1);
      }
      if (log) {
        const now = Date.now();
        if (now - lastFlush > FLUSH_INTERVAL_MS) {
          lastFlush = now;
          // Persiste progress + tail. Fire-and-forget (não trava o stream).
          log.update({
            restore_log_tail: stderr.slice(-4000),
            phase_progress: phases,
          }).catch(() => {});
        }
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      // Não deveria mais acontecer: o stage `preflight` prova o binário antes
      // de qualquer coisa ser criada. Se acontecer, a mensagem diz o caminho.
      reject(new Error(`Não foi possível executar pg_restore em "${bin}": ${err.message}`));
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (lineBuffer) flushLine(lineBuffer);
      // Marca fases iniciadas-mas-não-fechadas como fechadas
      const closedAt = new Date().toISOString();
      for (const ph of Object.values(phases)) {
        if (ph.started_at && !ph.finished_at) ph.finished_at = closedAt;
      }
      const finalTail = stderr.slice(-4000);
      if (log) log.update({ restore_log_tail: finalTail, phase_progress: phases }).catch(() => {});

      if (killed) {
        const err = new Error(`pg_restore abortado: ${killReason || 'timeout'}`);
        // Cascata de erros = as conexões caíram no meio (queda de rede ou, como
        // acontecia até aqui, outra rodada dropando o staging). Vale tentar de
        // novo com o arquivo que já está em disco. Timeout, não: repetir os
        // mesmos 90 minutos não muda nada.
        err.retryable = killReason?.startsWith('cascata') === true;
        return reject(err);
      }

      // 0 = success, 1 = warnings (esperado com --no-owner/--no-acl/--clean)
      if (code === 0 || code === 1) {
        return resolve({ ok: true, exitCode: code, stderrTail: stderr.slice(-2000), phases, errors });
      }
      reject(new Error(`pg_restore saiu com código ${code}. stderr tail:\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Pipeline blue-green do restore:
 *   1. preparing_staging  : dropa o staging anterior se sobrou, cria novo virgem
 *   2. restoring          : pg_restore no staging (banco de produção intacto)
 *   3. validating         : sanity check no staging (contagem/tamanho)
 *   4. swapping           : rename atômico — staging vira produção, antiga é dropada
 *   5. applying_grants    : reaplica permissões a partir de scripts/sienge-grants.sql
 *   6. applying_views     : recria as views criadas ao vivo pelo sienge_readonly
 *                           (snapshot tirado antes do swap; ver siengeCustomViews.js)
 *
 * Se qualquer passo até "validating" falhar, o staging é descartado e o banco
 * de produção continua intocado (sem janela de inconsistência).
 *
 * A janela entre o RENAME do antigo e o RENAME do staging dura tipicamente
 * <1s (rename é só metadado no catálogo do Postgres).
 */
async function restoreIntoPostgres(dmpcPath, log, { pgRestoreBin, settings }) {
  const { targetDb, stagingDb, targetUrl, stagingUrl, adminUrl } = buildPgUrls();

  const restoreOpts = {
    bin: pgRestoreBin,
    jobs: Number(settings.restore_jobs) || 2,
    timeoutMs: (Number(settings.restore_timeout_minutes) || 90) * 60_000,
  };

  // ── Inventário do dump (rápido) → UI consegue calcular % por fase ─────────
  let totals;
  try {
    totals = parseTocCounts(dmpcPath, pgRestoreBin);
    console.log(`[SiengeBackup] TOC totals:`, totals);
  } catch (err) {
    console.warn(`[SiengeBackup] parseTocCounts falhou: ${err.message}`);
    totals = { TABLE_DATA: 0, INDEX: 0, CONSTRAINT: 0, FK_CONSTRAINT: 0, TRIGGER: 0, SEQUENCE_SET: 0, OTHER: 0, TOTAL: 0 };
  }
  await log.update({
    toc_totals: totals,
    phase_progress: buildEmptyPhaseProgress(totals),
    import_status: 'running',
    import_job_name: 'pg_restore',
    import_started_at: new Date(),
  });

  // Sobras de swaps que morreram no meio. Só é seguro fazer isto com a trava
  // na mão — por isso mora aqui e não num cron solto.
  await dropLeftoverOldDatabases(targetDb).catch(e => {
    console.warn(`[SiengeBackup] limpeza de sobras falhou (segue): ${e.message}`);
  });

  // ── 1..3. Prepara staging, restaura e valida ──────────────────────────────
  // O ciclo inteiro é retentável: se o pg_restore cai por queda de conexão, o
  // staging fica pela metade e a única saída é recriá-lo — mas o .dmpc já está
  // em disco, então não repetimos o download de 1,5 GB.
  const maxAttempts = 1 + (Number(settings.restore_retry_attempts) || 0);
  let restoreResult;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let stagingCreated = false;
    try {
      await setStage(log, 'preparing_staging');
      console.log(`[SiengeBackup] preparing staging "${stagingDb}" (drop+create), tentativa ${attempt}/${maxAttempts}...`);
      await dropDatabaseIfExists(stagingDb);
      await createDatabase(stagingDb);
      stagingCreated = true;

      await setStage(log, 'restoring');
      restoreResult = await runPgRestore(dmpcPath, log, totals, stagingUrl, restoreOpts);

      await setStage(log, 'validating');
      const validation = await validateStaging(stagingUrl, totals);
      console.log(`[SiengeBackup] validation:`, validation);
      if (!validation.ok) {
        const err = new Error(`Validação do staging falhou: ${validation.errors.join('; ')}`);
        // Restore incompleto costuma vir de queda no meio: refazer resolve.
        err.retryable = true;
        throw err;
      }

      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // Falha até a validação = staging descartado, produção intocada. Só
      // dropamos o que ESTA rodada criou.
      if (stagingCreated) {
        console.warn(`[SiengeBackup] descartando staging "${stagingDb}" devido a falha: ${err.message}`);
        await dropDatabaseIfExists(stagingDb).catch(e => {
          console.warn(`[SiengeBackup] cleanup do staging falhou: ${e.message}`);
        });
      }

      const canRetry = err.retryable === true && attempt < maxAttempts;
      if (!canRetry) break;
      console.warn(`[SiengeBackup] restore falhou (${err.message}). Refazendo do arquivo local em 60s...`);
      await sleep(60_000);
    }
  }

  if (lastErr) throw lastErr;

  // ── 3.5 Snapshot das views custom do sienge_readonly (ANTES do swap) ────
  // Lê do banco vivo (intocado) e espelha no database `postgres`, que sobrevive
  // ao swap. Best-effort: se falhar, mantém o snapshot anterior (recria a véspera
  // em vez de perder as views). Pula na 1ª execução (produção ainda não existe).
  try {
    if (await databaseExists(targetDb)) {
      const snap = await snapshotCustomViews({ prodUrl: targetUrl, storeUrl: adminUrl });
      console.log(`[SiengeBackup] snapshot custom views:`, snap);
    }
  } catch (e) {
    console.warn(`[SiengeBackup] snapshot de views custom falhou (mantém snapshot anterior): ${e.message}`);
  }

  // ── 4. Swap atômico ─────────────────────────────────────────────────────
  await setStage(log, 'swapping');
  console.log(`[SiengeBackup] swap: "${stagingDb}" → "${targetDb}"...`);
  await swapDatabases(targetDb, stagingDb);

  // ── 5. Reaplica grants (não falha o restore se der erro) ────────────────
  await setStage(log, 'applying_grants');
  try {
    const grantsResult = await applyGrants(targetUrl);
    console.log(`[SiengeBackup] grants:`, grantsResult);
  } catch (e) {
    console.warn(`[SiengeBackup] applyGrants falhou (banco já promovido, ignorando): ${e.message}`);
  }

  // ── 6. Recria as views custom do sienge_readonly (depois dos grants, pra
  //       que o role tenha CREATE + SELECT). Não falha o restore se der erro. ──
  await setStage(log, 'applying_views');
  try {
    const viewsResult = await applyCustomViews({ targetUrl, storeUrl: adminUrl });
    console.log(`[SiengeBackup] custom views:`, viewsResult);
    if (viewsResult.failed?.length) {
      console.warn(`[SiengeBackup] views que não subiram:`, viewsResult.failed);
    }
  } catch (e) {
    console.warn(`[SiengeBackup] applyCustomViews falhou (banco já promovido, ignorando): ${e.message}`);
  }

  // ── 7. Índices de performance do Office (Custos/Títulos ao vivo). Best-effort:
  //       o banco já foi promovido; sem eles tudo funciona, só mais lento. ──
  try {
    const idxResult = await applyPerfIndexes(targetUrl);
    console.log(`[SiengeBackup] perf indexes:`, idxResult);
  } catch (e) {
    console.warn(`[SiengeBackup] applyPerfIndexes falhou (banco já promovido, ignorando): ${e.message}`);
  }

  // ── 8. Data do dado que acabou de entrar. É o que as telas consultam pra
  //       não mostrar número velho como se fosse de agora. ──────────────────
  clearFreshnessCache();
  let mirrorLastChange = null;
  try {
    // A sonda devolve a hora de parede que o Sienge gravou (coluna sem fuso);
    // a coluna daqui é timestamptz, então convertemos de Brasília.
    const wall = await probeMirrorLastChange();
    mirrorLastChange = brasiliaWallClockToInstant(wall);
    console.log(`[SiengeBackup] espelho agora vai até: ${wall}`);
  } catch (e) {
    console.warn(`[SiengeBackup] sonda de frescor falhou (banco já promovido): ${e.message}`);
  }

  const finishedAt = new Date();
  await log.update({
    import_status: 'success',
    import_finished_at: finishedAt,
    import_duration_ms: finishedAt - new Date(log.import_started_at),
    mirror_last_change: mirrorLastChange,
  });
  return restoreResult;
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

/**
 * Uma rodada completa, já com a trava na mão.
 *
 * Nunca chame direto: use runDailyBackup(), que é quem garante a exclusão
 * mútua. Duas rodadas simultâneas destroem uma à outra (o staging é um recurso
 * global) — foi exatamente o que derrubou 39% das cargas até aqui.
 */
async function runDailyBackupLocked({ triggeredBy, attempt, pgRestoreBin }) {
  await mkdir(TMP_DIR, { recursive: true });

  const settings = await getSettings();

  const startedAt = new Date();
  const yyyymmdd  = startedAt.toISOString().slice(0, 10);
  const localGz   = path.join(TMP_DIR, `sienge-${yyyymmdd}.dmpc.gz`);
  const localDmpc = path.join(TMP_DIR, `sienge-${yyyymmdd}.dmpc`);

  const log = await db.SiengeBackupLog.create({
    started_at: startedAt,
    status: 'running',
    stage: 'starting',
    triggered_by: triggeredBy,
    attempt,
    instance_id: instanceId(),
    heartbeat_at: startedAt,
    stage_timings: {
      starting: { started_at: startedAt.toISOString(), finished_at: startedAt.toISOString() },
    },
  });

  // Batida periódica: a tela e o vigia usam isso pra saber que a rodada está
  // viva. Sem ela, um container morto no meio deixa um log `running` eterno.
  const heartbeat = setInterval(() => {
    log.update({ heartbeat_at: new Date() }).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    // 0. Preflight — o binário já foi provado antes da trava; aqui confirmamos
    //    que o Postgres alvo responde, ANTES de dropar e recriar o staging.
    //    Falhar aqui não deixa nada pela metade.
    await setStage(log, 'preflight');
    await withAdminClient(c => c.query('SELECT 1'));
    await log.update({ pg_restore_bin: pgRestoreBin });
    console.log(`[SiengeBackup] preflight ok — ${pgRestoreBin}`);

    // 1. MD5 esperado
    await setStage(log, 'fetching_md5');
    const expectedMd5 = await fetchExpectedMd5();

    // 2. Download + hash local
    await setStage(log, 'downloading');
    const { md5: actualMd5, size } = await downloadAndHash(localGz, log);

    await log.update({
      md5_expected: expectedMd5,
      md5_actual: actualMd5,
      file_size_bytes: size,
      file_name: `sienge-${yyyymmdd}.dmpc.gz`,
    });

    if (expectedMd5 && expectedMd5 !== actualMd5) {
      throw new Error(`MD5 não bate. esperado=${expectedMd5} baixado=${actualMd5}`);
    }

    // 3. Descomprime localmente
    await setStage(log, 'decompressing');
    await decompressGzToFile(localGz, localDmpc);
    await unlink(localGz).catch(() => {});

    // 4. Restore no Postgres
    if (!AUTO_RESTORE_ENABLED) {
      await log.update({ import_status: 'skipped' });
    } else {
      try {
        await restoreIntoPostgres(localDmpc, log, { pgRestoreBin, settings });
      } catch (restoreErr) {
        const finishedAt = new Date();
        await log.update({
          import_status: 'failed',
          import_finished_at: finishedAt,
          import_duration_ms: finishedAt - new Date(log.import_started_at || startedAt),
          import_error_message: String(restoreErr?.message || restoreErr).slice(0, 4000),
        });
        throw restoreErr;
      }
    }

    // 5. Cleanup local
    await unlink(localDmpc).catch(() => {});

    await setStage(log, 'done');
    const finishedAt = new Date();
    await log.update({
      status: 'success',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });

    return { ok: true, logId: log.id, size };
  } catch (err) {
    const finishedAt = new Date();
    await closeCurrentStage(log);
    await log.update({
      status: 'failed',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
      error_message: String(err?.message || err).slice(0, 4000),
    });
    await unlink(localGz).catch(() => {});
    await unlink(localDmpc).catch(() => {});
    err.logId = log.id;
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Pipeline diário, com exclusão mútua.
 *
 * Se outra instância já está com a trava, esta rodada NÃO executa — registra
 * `skipped/lock_busy` com o instance_id e sai. Antes disso ela entrava mesmo
 * assim e dropava o database de staging da outra, que é a origem dos três modos
 * de falha do histórico.
 *
 * Devolve `{ ok: false, skipped: true }` quando foi barrada.
 */
export async function runDailyBackup({ triggeredBy = 'cron', attempt = 1 } = {}) {
  // Preflight do binário ANTES da trava, de propósito.
  //
  // A instância que não tem pg_restore não pode nem ocupar a fila: se ela
  // pegasse a trava, a instância boa seria dispensada e o dia ficaria sem
  // carga até a retentativa. Falhando aqui, ela sai de cena em um segundo e a
  // instância boa roda no horário.
  //
  // É registrado como `skipped` (não `failed`): não é a carga que falhou, é
  // esta máquina que não podia fazê-la. Quem cobra o resultado é o vigia de
  // frescor, que olha a idade do espelho.
  let pgRestoreBin;
  try {
    pgRestoreBin = probePgRestore().bin;
  } catch (err) {
    const now = new Date();
    console.error(`⛔ [SiengeBackup] esta instância (${instanceId()}) não pode restaurar: ${err.message}`);
    await db.SiengeBackupLog.create({
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      status: 'skipped',
      stage: 'preflight',
      triggered_by: triggeredBy,
      attempt,
      instance_id: instanceId(),
      error_message: String(err.message).slice(0, 4000),
      stage_timings: { preflight: { started_at: now.toISOString(), finished_at: now.toISOString() } },
    }).catch(e => console.warn('[SiengeBackup] não consegui registrar o preflight:', e.message));
    return { ok: false, skipped: true, reason: 'preflight' };
  }

  const { locked, result } = await withBackupLock(
    () => runDailyBackupLocked({ triggeredBy, attempt, pgRestoreBin }),
    {
      onBusy: async () => {
        const now = new Date();
        console.warn(`⏭️  [SiengeBackup] outra rodada já está em andamento — esta instância (${instanceId()}) não vai executar.`);
        await db.SiengeBackupLog.create({
          started_at: now,
          finished_at: now,
          duration_ms: 0,
          status: 'skipped',
          stage: 'lock_busy',
          triggered_by: triggeredBy,
          attempt,
          instance_id: instanceId(),
          error_message: 'Outra rodada da carga já estava em andamento; esta foi dispensada pela trava.',
          stage_timings: {
            lock_busy: { started_at: now.toISOString(), finished_at: now.toISOString() },
          },
        }).catch(e => console.warn('[SiengeBackup] não consegui registrar o skip:', e.message));
      },
    }
  );

  if (!locked) return { ok: false, skipped: true, reason: 'lock_busy' };
  return result;
}

export default { runDailyBackup };
