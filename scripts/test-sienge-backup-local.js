// scripts/test-sienge-backup-local.js
//
// Teste local do pipeline de backup do Sienge.
// Faz tudo que o SiengeBackupService faz, MENOS conectar no Postgres do
// Railway e MENOS gravar log no banco. Tudo é stdout pra inspeção.
//
// Pipeline:
//   1. Lê credenciais do .env do Meninger-Back
//   2. Busca MD5 esperado em SIENGE_BACKUP_MD5_URL
//   3. Baixa SIENGE_BACKUP_URL → temp/sienge-backup-test/sienge-YYYY-MM-DD.dmpc.gz
//      (com Content-Length, progresso e MD5 streaming)
//   4. Compara MD5 esperado × calculado
//   5. Descomprime gzip → .dmpc (formato custom do pg_dump)
//   6. Se pg_restore estiver disponível no PATH:
//        - lista TOC (-l)        → .toc.txt
//        - converte para SQL     → .sql
//      Se NÃO estiver disponível:
//        - imprime instruções e mantém só o .dmpc
//   7. Mostra resumo (tamanhos, MD5, paths, duração por stage)
//
// Uso:
//   node scripts/test-sienge-backup-local.js
//
// Flags (opcionais):
//   --keep-gz           mantém o .dmpc.gz após descomprimir (default: apaga)
//   --skip-sql          não tenta converter para SQL mesmo com pg_restore disponível
//   --reuse             se já existe arquivo do dia, reaproveita (não baixa de novo)
//   --out=<dir>         sobrescreve diretório de saída (default: ./temp/sienge-backup-test)

import { createWriteStream, createReadStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import dotenv from 'dotenv';

// ── Setup ─────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Carrega .env do diretório do backend (um nível acima de /scripts)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FLAG_KEEP_GZ  = args.includes('--keep-gz');
const FLAG_SKIP_SQL = args.includes('--skip-sql');
const FLAG_REUSE    = args.includes('--reuse');
const OUT_DIR = (() => {
  const a = args.find(x => x.startsWith('--out='));
  if (a) return path.resolve(a.slice('--out='.length));
  return path.join(__dirname, '..', 'temp', 'sienge-backup-test');
})();

// ── Env ───────────────────────────────────────────────────────────────────────
const SIENGE_USER     = process.env.SIENGE_BACKUP_USER;
const SIENGE_PASSWORD = process.env.SIENGE_BACKUP_PASSWORD;
const SIENGE_URL      = process.env.SIENGE_BACKUP_URL;
const SIENGE_MD5_URL  = process.env.SIENGE_BACKUP_MD5_URL;

function assertEnv() {
  const missing = [];
  if (!SIENGE_USER)     missing.push('SIENGE_BACKUP_USER');
  if (!SIENGE_PASSWORD) missing.push('SIENGE_BACKUP_PASSWORD');
  if (!SIENGE_URL)      missing.push('SIENGE_BACKUP_URL');
  if (!SIENGE_MD5_URL)  missing.push('SIENGE_BACKUP_MD5_URL');
  if (missing.length) {
    log.error(`Variáveis ausentes no .env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────
const stages = [];
let currentStage = null;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

const log = {
  info:  (msg) => console.log(`[${ts()}] ℹ  ${msg}`),
  step:  (msg) => console.log(`[${ts()}] ▶  ${msg}`),
  ok:    (msg) => console.log(`[${ts()}] ✅ ${msg}`),
  warn:  (msg) => console.warn(`[${ts()}] ⚠  ${msg}`),
  error: (msg) => console.error(`[${ts()}] ❌ ${msg}`),
  raw:   (msg) => process.stdout.write(msg),
};

function startStage(name) {
  if (currentStage) endStage();
  currentStage = { name, startedAt: Date.now() };
  stages.push(currentStage);
  log.step(`── stage: ${name}`);
}

function endStage() {
  if (!currentStage) return;
  currentStage.finishedAt = Date.now();
  currentStage.durationMs = currentStage.finishedAt - currentStage.startedAt;
  log.ok(`└─ stage "${currentStage.name}" levou ${humanMs(currentStage.durationMs)}`);
  currentStage = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function siengeAuthHeader() {
  return 'Basic ' + Buffer.from(`${SIENGE_USER}:${SIENGE_PASSWORD}`).toString('base64');
}

function humanBytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

function humanMs(ms) {
  if (ms == null) return '?';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = (s - m * 60).toFixed(0);
  return `${m}m${rs}s`;
}

function describeFetchError(err) {
  const code     = err?.cause?.code || err?.code;
  const causeMsg = err?.cause?.message;
  const top      = err?.message || String(err);
  return [top, code && `code=${code}`, causeMsg && `cause=${causeMsg}`].filter(Boolean).join(' | ');
}

function isTransientNetworkError(err) {
  const text = describeFetchError(err).toLowerCase();
  return /terminated|econnreset|etimedout|enotfound|eai_again|und_err|socket hang up|network|fetch failed|other side closed|aborted/i.test(text);
}

function detectPgRestore() {
  // 1) PATH
  // 2) Zip portátil extraído em Meninger-Back/bin/postgresql-*/bin/
  //    (gerado por `node scripts/setup-pg-tools.js`)
  // 3) Override via env PG_RESTORE_BIN
  const candidates = [];
  if (process.env.PG_RESTORE_BIN) candidates.push(process.env.PG_RESTORE_BIN);

  const binDir = path.join(__dirname, '..', 'bin');
  if (existsSync(binDir)) {
    try {
      const entries = readdirSync(binDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const inner = path.join(binDir, e.name, 'bin', process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore');
        if (existsSync(inner)) candidates.push(inner);
      }
    } catch { /* ignore */ }
  }

  candidates.push('pg_restore', 'pg_restore.exe');

  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { stdio: 'pipe' });
      if (r.status === 0) {
        const ver = (r.stdout?.toString() || '').trim();
        return { available: true, bin, version: ver };
      }
    } catch { /* keep trying */ }
  }
  return { available: false };
}

// ── Fase 1: MD5 esperado ──────────────────────────────────────────────────────
async function fetchExpectedMd5() {
  log.info(`GET ${SIENGE_MD5_URL}`);
  const res = await fetch(SIENGE_MD5_URL, { headers: { Authorization: siengeAuthHeader() } });
  if (!res.ok) throw new Error(`MD5 endpoint retornou ${res.status} ${res.statusText}`);
  const text = (await res.text()).trim();
  const md5  = text.split(/\s+/)[0].toLowerCase();
  log.info(`MD5 esperado (raw response): ${JSON.stringify(text)}`);
  log.info(`MD5 esperado (parsed): ${md5}`);
  return md5;
}

// ── Fase 2: download + hash em streaming ──────────────────────────────────────
async function downloadAndHashOnce(localPath) {
  log.info(`GET ${SIENGE_URL}`);
  const res = await fetch(SIENGE_URL, {
    headers: {
      Authorization: siengeAuthHeader(),
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
    },
  });
  if (!res.ok) throw new Error(`Download falhou: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Resposta sem body');

  const contentLength = Number(res.headers.get('content-length')) || null;
  log.info(`Content-Length: ${contentLength != null ? humanBytes(contentLength) + ` (${contentLength} bytes)` : 'desconhecido'}`);
  log.info(`Content-Type: ${res.headers.get('content-type') || 'desconhecido'}`);
  log.info(`Salvando em: ${localPath}`);

  const hash = createHash('md5');
  const fileStream = createWriteStream(localPath);
  let bytesAcc = 0;
  let lastLog = 0;
  const LOG_INTERVAL_MS = 3000;
  const startedAt = Date.now();

  const hashTransform = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytesAcc += chunk.length;
      const now = Date.now();
      if (now - lastLog > LOG_INTERVAL_MS) {
        lastLog = now;
        const elapsed = (now - startedAt) / 1000;
        const rate    = elapsed > 0 ? bytesAcc / elapsed : 0;
        const pct     = contentLength ? ((bytesAcc / contentLength) * 100).toFixed(1) + '%' : '?';
        log.info(`   ↓ ${humanBytes(bytesAcc)} / ${contentLength ? humanBytes(contentLength) : '?'} (${pct}) — ${humanBytes(rate)}/s`);
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body), hashTransform, fileStream);

  const stats = await stat(localPath);
  log.info(`   ↓ total: ${humanBytes(stats.size)} (${stats.size} bytes)`);
  return { md5: hash.digest('hex').toLowerCase(), size: stats.size };
}

async function downloadAndHash(localPath) {
  const maxAttempts = Number(process.env.SIENGE_DOWNLOAD_MAX_ATTEMPTS || 3);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) log.info(`Retry ${attempt}/${maxAttempts}…`);
      return await downloadAndHashOnce(localPath);
    } catch (err) {
      lastErr = err;
      log.warn(`Tentativa ${attempt}/${maxAttempts} falhou: ${describeFetchError(err)}`);
      await unlink(localPath).catch(() => {});
      if (!isTransientNetworkError(err) || attempt === maxAttempts) break;
      const wait = Math.min(30_000 * Math.pow(4, attempt - 1), 5 * 60_000);
      log.info(`Aguardando ${wait / 1000}s antes do próximo retry…`);
      await sleep(wait);
    }
  }
  const finalErr = new Error(`Download falhou após ${maxAttempts} tentativas: ${describeFetchError(lastErr)}`);
  finalErr.cause = lastErr;
  throw finalErr;
}

// ── Fase 3: descomprime gzip → .dmpc ──────────────────────────────────────────
async function decompressGzToFile(gzPath, dmpcPath) {
  log.info(`Descomprimindo ${gzPath} → ${dmpcPath}`);
  const startedAt = Date.now();
  let bytesIn = 0;
  let bytesOut = 0;

  const counterIn = new Transform({
    transform(chunk, _enc, cb) { bytesIn += chunk.length; cb(null, chunk); },
  });
  const counterOut = new Transform({
    transform(chunk, _enc, cb) { bytesOut += chunk.length; cb(null, chunk); },
  });

  await pipeline(
    createReadStream(gzPath),
    counterIn,
    createGunzip(),
    counterOut,
    createWriteStream(dmpcPath),
  );
  const out = await stat(dmpcPath);
  const elapsed = (Date.now() - startedAt) / 1000;
  log.info(`   in : ${humanBytes(bytesIn)}`);
  log.info(`   out: ${humanBytes(out.size)} (verify=${bytesOut === out.size})`);
  log.info(`   ratio: ${(out.size / bytesIn).toFixed(2)}× em ${elapsed.toFixed(1)}s`);
}

// ── Fase 4: TOC + conversão para SQL (opcional, se pg_restore disponível) ─────
function runPgRestoreToc(pgBin, dmpcPath, tocPath) {
  return new Promise((resolve, reject) => {
    log.info(`Listando TOC: ${pgBin} -l ${dmpcPath}`);
    const proc = spawn(pgBin, ['-l', dmpcPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(tocPath);
    let stderr = '';
    proc.stdout.pipe(out);
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore -l exit=${code}\n${stderr.slice(-2000)}`));
    });
  });
}

function runPgRestoreToSql(pgBin, dmpcPath, sqlPath) {
  return new Promise((resolve, reject) => {
    const args = ['--no-owner', '--no-privileges', '--no-acl', '-f', sqlPath, dmpcPath];
    log.info(`Convertendo para SQL: ${pgBin} ${args.join(' ')}`);
    const startedAt = Date.now();
    const proc = spawn(pgBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let lastLog = 0;
    proc.stderr.on('data', c => {
      const s = c.toString();
      stderr += s;
      const now = Date.now();
      if (now - lastLog > 3000) {
        lastLog = now;
        const tail = s.trim().split('\n').pop();
        if (tail) log.info(`   pg_restore: ${tail}`);
      }
    });
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (code === 0 || code === 1) {
        log.info(`   pg_restore terminou em ${elapsed.toFixed(1)}s (exit=${code})`);
        resolve({ exitCode: code, stderrTail: stderr.slice(-2000) });
      } else {
        reject(new Error(`pg_restore exit=${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function main() {
  const overallStart = Date.now();

  log.info('═'.repeat(72));
  log.info('Sienge Backup — teste local (sem Railway, sem banco)');
  log.info('═'.repeat(72));

  assertEnv();

  log.info(`Out dir: ${OUT_DIR}`);
  log.info(`Flags: keep-gz=${FLAG_KEEP_GZ}, skip-sql=${FLAG_SKIP_SQL}, reuse=${FLAG_REUSE}`);

  await mkdir(OUT_DIR, { recursive: true });

  const yyyymmdd  = new Date().toISOString().slice(0, 10);
  const gzPath    = path.join(OUT_DIR, `sienge-${yyyymmdd}.dmpc.gz`);
  const dmpcPath  = path.join(OUT_DIR, `sienge-${yyyymmdd}.dmpc`);
  const tocPath   = path.join(OUT_DIR, `sienge-${yyyymmdd}.toc.txt`);
  const sqlPath   = path.join(OUT_DIR, `sienge-${yyyymmdd}.sql`);

  let expectedMd5 = null;
  let actualMd5   = null;
  let gzSize      = null;
  let dmpcSize    = null;

  // Atalho: --reuse e o .dmpc já está descomprimido em disco. Pula MD5 e
  // descompressão e vai direto para a conversão.
  const reusingDmpc = FLAG_REUSE && !existsSync(gzPath) && existsSync(dmpcPath);
  if (reusingDmpc) {
    startStage('reusing_dmpc');
    const s = await stat(dmpcPath);
    dmpcSize = s.size;
    log.warn(`Reaproveitando .dmpc existente: ${dmpcPath} (${humanBytes(dmpcSize)})`);
    log.info('Pulando MD5 fetch + download + verify + decompress.');
    endStage();
  } else {
    // ─── Stage: fetching_md5 ───────────────────────────────────────────────
    startStage('fetching_md5');
    expectedMd5 = await fetchExpectedMd5();
    endStage();

    // ─── Stage: downloading ────────────────────────────────────────────────
    if (FLAG_REUSE && existsSync(gzPath)) {
      startStage('downloading (reuse)');
      log.warn(`Reaproveitando .gz existente: ${gzPath}`);
      log.info('Recalculando MD5 local…');
      const hash = createHash('md5');
      let bytes = 0;
      await pipeline(
        createReadStream(gzPath),
        new Transform({
          transform(chunk, _e, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
        }),
        new Transform({ transform(_c, _e, cb) { cb(); } }),
      );
      actualMd5 = hash.digest('hex').toLowerCase();
      gzSize = bytes;
      log.info(`MD5 calculado do arquivo reaproveitado: ${actualMd5} (${humanBytes(gzSize)})`);
      endStage();
    } else {
      startStage('downloading');
      const r = await downloadAndHash(gzPath);
      actualMd5 = r.md5;
      gzSize = r.size;
      endStage();
    }

    // ─── Stage: verifying_md5 ──────────────────────────────────────────────
    startStage('verifying_md5');
    log.info(`Esperado: ${expectedMd5}`);
    log.info(`Calculado: ${actualMd5}`);
    if (expectedMd5 && expectedMd5 !== actualMd5) {
      throw new Error(`MD5 não bate! esperado=${expectedMd5} calculado=${actualMd5}`);
    }
    log.ok('MD5 bate.');
    endStage();

    // ─── Stage: decompressing ──────────────────────────────────────────────
    startStage('decompressing');
    await decompressGzToFile(gzPath, dmpcPath);
    const dmpcStat = await stat(dmpcPath);
    dmpcSize = dmpcStat.size;
    endStage();

    if (!FLAG_KEEP_GZ) {
      log.info(`Removendo .gz (use --keep-gz para manter): ${gzPath}`);
      await unlink(gzPath).catch(err => log.warn(`Falha ao remover .gz: ${err.message}`));
    }
  }

  // ─── Stage: pg_restore (opcional) ────────────────────────────────────────
  let pgInfo = { available: false };
  let sqlSize = null;
  if (!FLAG_SKIP_SQL) {
    pgInfo = detectPgRestore();
    if (pgInfo.available) {
      log.info(`pg_restore encontrado: ${pgInfo.version}`);

      startStage('listing_toc');
      try {
        await runPgRestoreToc(pgInfo.bin, dmpcPath, tocPath);
        const tocStat = await stat(tocPath);
        log.ok(`TOC salvo em ${tocPath} (${humanBytes(tocStat.size)})`);
      } catch (err) {
        log.warn(`Falha ao listar TOC: ${err.message}`);
      }
      endStage();

      startStage('converting_to_sql');
      try {
        await runPgRestoreToSql(pgInfo.bin, dmpcPath, sqlPath);
        const sqlStat = await stat(sqlPath);
        sqlSize = sqlStat.size;
        log.ok(`SQL salvo em ${sqlPath} (${humanBytes(sqlSize)})`);
      } catch (err) {
        log.warn(`Falha ao converter para SQL: ${err.message}`);
      }
      endStage();
    } else {
      startStage('converting_to_sql (pulado)');
      log.warn('pg_restore NÃO encontrado no PATH nem em ./bin/postgresql-*/bin/.');
      log.warn('O arquivo .dmpc está no formato custom do pg_dump (-Fc), legível só com pg_restore.');
      log.warn('Para baixar o cliente PostgreSQL portátil (sem admin):');
      log.warn('  npm run setup:pg-tools');
      log.warn('Ou aponte PG_RESTORE_BIN=<caminho> manualmente. Depois rode com --reuse:');
      log.warn(`  npm run test:sienge-backup -- --reuse`);
      log.warn('Comando equivalente que rodaria:');
      log.warn(`  pg_restore --no-owner --no-privileges --no-acl -f "${sqlPath}" "${dmpcPath}"`);
      endStage();
    }
  } else {
    log.info('Conversão para SQL pulada por --skip-sql.');
  }

  endStage();

  // ─── Resumo ──────────────────────────────────────────────────────────────
  const totalMs = Date.now() - overallStart;
  log.info('═'.repeat(72));
  log.info('Resumo');
  log.info('═'.repeat(72));
  log.info(`Data           : ${yyyymmdd}`);
  log.info(`Out dir        : ${OUT_DIR}`);
  log.info(`MD5 esperado   : ${expectedMd5}`);
  log.info(`MD5 calculado  : ${actualMd5}`);
  log.info(`.dmpc.gz       : ${gzSize != null ? humanBytes(gzSize) : '(removido)'} ${FLAG_KEEP_GZ ? `→ ${gzPath}` : '(apagado)'}`);
  log.info(`.dmpc          : ${humanBytes(dmpcSize)} → ${dmpcPath}`);
  log.info(`.toc.txt       : ${pgInfo.available ? `→ ${tocPath}` : '(pg_restore ausente)'}`);
  log.info(`.sql           : ${sqlSize != null ? `${humanBytes(sqlSize)} → ${sqlPath}` : '(não gerado)'}`);
  log.info('');
  log.info('Stages:');
  for (const s of stages) {
    log.info(`  • ${s.name.padEnd(28)} ${humanMs(s.durationMs ?? (Date.now() - s.startedAt))}`);
  }
  log.info(`Total          : ${humanMs(totalMs)}`);
  log.ok('Pipeline local concluído.');
}

main().catch(err => {
  endStage();
  log.error(`Pipeline falhou: ${err?.message || err}`);
  if (err?.cause) log.error(`cause: ${describeFetchError(err.cause)}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
