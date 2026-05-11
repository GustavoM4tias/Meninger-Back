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

import { createWriteStream, createReadStream } from 'node:fs';
import { unlink, mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import db from '../../models/sequelize/index.js';

// ── Sienge API ────────────────────────────────────────────────────────────────
const SIENGE_USER     = process.env.SIENGE_BACKUP_USER;
const SIENGE_PASSWORD = process.env.SIENGE_BACKUP_PASSWORD;
const SIENGE_URL      = process.env.SIENGE_BACKUP_URL;
const SIENGE_MD5_URL  = process.env.SIENGE_BACKUP_MD5_URL;

// ── PostgreSQL alvo do restore (Railway) ──────────────────────────────────────
const SIENGE_PG_URL         = process.env.SIENGE_PG_URL;
const SIENGE_PG_DATABASE    = process.env.SIENGE_PG_DATABASE || 'sie214801';
const AUTO_RESTORE_ENABLED  = process.env.ENABLE_SIENGE_AUTO_RESTORE !== 'false';
const PG_RESTORE_JOBS       = Number(process.env.SIENGE_PG_RESTORE_JOBS || 2);
const PG_RESTORE_TIMEOUT_MS = Number(process.env.SIENGE_PG_RESTORE_TIMEOUT_MS || 90 * 60 * 1000);

const TMP_DIR = path.join(tmpdir(), 'sienge-backup');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function siengeAuthHeader() {
  return 'Basic ' + Buffer.from(`${SIENGE_USER}:${SIENGE_PASSWORD}`).toString('base64');
}

/**
 * Constrói duas URLs de conexão a partir de SIENGE_PG_URL:
 *   - adminUrl: aponta pro database "postgres" (pra CREATE DATABASE)
 *   - targetUrl: aponta pro database alvo (pra pg_restore)
 *
 * SIENGE_PG_URL pode vir com ou sem database no path. Se sem, usamos
 * SIENGE_PG_DATABASE.
 */
function buildPgUrls() {
  if (!SIENGE_PG_URL) throw new Error('SIENGE_PG_URL não configurada');

  const u = new URL(SIENGE_PG_URL);
  const hasPath = u.pathname && u.pathname !== '/' && u.pathname !== '';
  const targetDb = hasPath ? u.pathname.replace(/^\//, '') : SIENGE_PG_DATABASE;

  const admin = new URL(SIENGE_PG_URL);
  admin.pathname = '/postgres';

  const target = new URL(SIENGE_PG_URL);
  target.pathname = '/' + targetDb;

  return {
    adminUrl: admin.toString(),
    targetUrl: target.toString(),
    targetDb,
  };
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

async function downloadAndHashOnce(localPath) {
  const res = await fetch(SIENGE_URL, {
    headers: {
      Authorization: siengeAuthHeader(),
      'Accept-Encoding': 'identity', // não pede gzip de novo (já vem .gz por content)
      'Connection': 'keep-alive',
    },
  });
  if (!res.ok) throw new Error(`Download Sienge falhou: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Resposta do Sienge sem body');

  const hash = createHash('md5');
  const fileStream = createWriteStream(localPath);
  const hashTransform = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), hashTransform, fileStream);
  const stats = await stat(localPath);
  return { md5: hash.digest('hex').toLowerCase(), size: stats.size };
}

async function downloadAndHash(localPath) {
  const maxAttempts = Number(process.env.SIENGE_DOWNLOAD_MAX_ATTEMPTS || 3);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`🔁 [SiengeBackup] Retry download tentativa ${attempt}/${maxAttempts}`);
      }
      return await downloadAndHashOnce(localPath);
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

async function ensureTargetDatabaseExists() {
  const { adminUrl, targetDb } = buildPgUrls();
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    if (r.rowCount === 0) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(targetDb)) {
        throw new Error(`Nome de database inválido: ${targetDb}`);
      }
      await client.query(`CREATE DATABASE "${targetDb}"`);
    }
  } finally {
    await client.end();
  }
}

function runPgRestore(dmpcPath) {
  const { targetUrl } = buildPgUrls();

  return new Promise((resolve, reject) => {
    const args = [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--no-acl',
      '--jobs', String(PG_RESTORE_JOBS),
      '--dbname', targetUrl,
      dmpcPath,
    ];

    const proc = spawn('pg_restore', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, PG_RESTORE_TIMEOUT_MS);

    proc.stderr.on('data', chunk => {
      const s = chunk.toString();
      stderr += s;
      if (/error|fatal|warning/i.test(s)) {
        console.log('[pg_restore]', s.trim());
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Não foi possível executar pg_restore (binário disponível?): ${err.message}`));
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return reject(new Error('pg_restore timeout'));

      // 0 = success, 1 = warnings (esperado com --no-owner/--no-acl/--clean)
      if (code === 0 || code === 1) {
        return resolve({ ok: true, exitCode: code, stderrTail: stderr.slice(-2000) });
      }
      reject(new Error(`pg_restore saiu com código ${code}. stderr tail:\n${stderr.slice(-2000)}`));
    });
  });
}

async function restoreIntoPostgres(dmpcPath, log) {
  await log.update({
    import_status: 'running',
    import_job_name: 'pg_restore',
    import_started_at: new Date(),
    stage: 'restoring',
  });

  await ensureTargetDatabaseExists();
  const result = await runPgRestore(dmpcPath);

  const finishedAt = new Date();
  await log.update({
    import_status: 'success',
    import_finished_at: finishedAt,
    import_duration_ms: finishedAt - new Date(log.import_started_at),
  });
  return result;
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

export async function runDailyBackup({ triggeredBy = 'cron' } = {}) {
  await mkdir(TMP_DIR, { recursive: true });

  const startedAt = new Date();
  const yyyymmdd  = startedAt.toISOString().slice(0, 10);
  const localGz   = path.join(TMP_DIR, `sienge-${yyyymmdd}.dmpc.gz`);
  const localDmpc = path.join(TMP_DIR, `sienge-${yyyymmdd}.dmpc`);

  const log = await db.SiengeBackupLog.create({
    started_at: startedAt,
    status: 'running',
    stage: 'starting',
    triggered_by: triggeredBy,
  });

  try {
    // 1. MD5 esperado
    await log.update({ stage: 'fetching_md5' });
    const expectedMd5 = await fetchExpectedMd5();

    // 2. Download + hash local
    await log.update({ stage: 'downloading' });
    const { md5: actualMd5, size } = await downloadAndHash(localGz);

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
    await log.update({ stage: 'decompressing' });
    await decompressGzToFile(localGz, localDmpc);
    await unlink(localGz).catch(() => {});

    // 4. Restore no Postgres
    if (!AUTO_RESTORE_ENABLED) {
      await log.update({ import_status: 'skipped' });
    } else {
      try {
        await restoreIntoPostgres(localDmpc, log);
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

    const finishedAt = new Date();
    await log.update({
      status: 'success',
      stage: 'done',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });

    return { ok: true, logId: log.id, size };
  } catch (err) {
    const finishedAt = new Date();
    await log.update({
      status: 'failed',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
      error_message: String(err?.message || err).slice(0, 4000),
    });
    await unlink(localGz).catch(() => {});
    await unlink(localDmpc).catch(() => {});
    throw err;
  }
}

export default { runDailyBackup };
