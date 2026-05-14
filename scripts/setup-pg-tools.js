// scripts/setup-pg-tools.js
//
// Baixa o cliente PostgreSQL portátil (sem instalador, sem admin) usado pelo
// `test-sienge-backup-local.js` pra converter o dump .dmpc em SQL.
//
// Fonte: https://github.com/theseus-rs/postgresql-binaries (builds portáteis
// oficiais de cada versão major do Postgres; usados também pelo crate Rust
// `postgresql-embedded`). Cada release publica um zip/tarball por plataforma
// contendo `bin/`, `lib/` e `share/` — exatamente o que o instalador instala,
// só que extraível em qualquer pasta do usuário.
//
// Resultado final:
//   Meninger-Back/bin/postgresql-17.5.0-<triple>/bin/pg_restore[.exe]
//
// O `test-sienge-backup-local.js` faz um scan em ./bin/ e usa o pg_restore
// que encontrar — não precisa configurar PATH.
//
// Idempotente: se já existir um pg_restore funcional na pasta destino, sai
// imediatamente. Use --force pra rebaixar.

import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
// 17.5.0 bate com o major do Sienge (Postgres 17 — ver nixpacks.toml).
// O pg_restore é forward-compatible com dumps de versões anteriores, mas
// usar o mesmo major elimina qualquer surpresa.
const PG_VERSION = process.env.PG_SETUP_VERSION || '17.5.0';

const PLATFORM_TRIPLES = {
  'win32-x64':  'x86_64-pc-windows-msvc',
  'linux-x64':  'x86_64-unknown-linux-gnu',
  'linux-arm64':'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64':'aarch64-apple-darwin',
};

const args = process.argv.slice(2);
const FLAG_FORCE = args.includes('--force');

// ── Logger ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}
const log = {
  info:  (m) => console.log(`[${ts()}] ℹ  ${m}`),
  step:  (m) => console.log(`[${ts()}] ▶  ${m}`),
  ok:    (m) => console.log(`[${ts()}] ✅ ${m}`),
  warn:  (m) => console.warn(`[${ts()}] ⚠  ${m}`),
  error: (m) => console.error(`[${ts()}] ❌ ${m}`),
};

function humanBytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

// ── Detecção de plataforma ────────────────────────────────────────────────────
function detectTriple() {
  const key = `${process.platform}-${process.arch}`;
  const triple = PLATFORM_TRIPLES[key];
  if (!triple) {
    throw new Error(`Plataforma não mapeada: ${key}. Plataformas suportadas: ${Object.keys(PLATFORM_TRIPLES).join(', ')}`);
  }
  return triple;
}

// ── Download com seguimento de redirects + progresso ──────────────────────────
async function downloadWithProgress(url, dest) {
  log.info(`GET ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download falhou: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Resposta sem body');
  const total = Number(res.headers.get('content-length')) || null;
  log.info(`Content-Length: ${total != null ? humanBytes(total) : 'desconhecido'}`);
  log.info(`Salvando em: ${dest}`);

  let bytes = 0;
  let lastLog = 0;
  const startedAt = Date.now();
  const progress = new Transform({
    transform(chunk, _e, cb) {
      bytes += chunk.length;
      const now = Date.now();
      if (now - lastLog > 2000) {
        lastLog = now;
        const elapsed = (now - startedAt) / 1000;
        const rate = elapsed > 0 ? bytes / elapsed : 0;
        const pct  = total ? ((bytes / total) * 100).toFixed(1) + '%' : '?';
        log.info(`   ↓ ${humanBytes(bytes)} / ${total ? humanBytes(total) : '?'} (${pct}) — ${humanBytes(rate)}/s`);
      }
      cb(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(dest));
  const s = await stat(dest);
  log.info(`   ↓ total: ${humanBytes(s.size)}`);
  return s.size;
}

// ── Extração ──────────────────────────────────────────────────────────────────
function extractZip(zipPath, destDir) {
  // Usa PowerShell Expand-Archive em Windows; tar (BSD tar) em macOS/Linux.
  log.info(`Extraindo ${zipPath} → ${destDir}`);
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`Expand-Archive falhou (exit=${r.status})`);
  } else {
    // unzip ou tar — preferimos tar (presente em macOS/Linux por default).
    const r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`tar -xf falhou (exit=${r.status})`);
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function main() {
  const triple = detectTriple();
  const folderName = `postgresql-${PG_VERSION}-${triple}`;
  const ext      = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const fileName = `${folderName}.${ext}`;
  const url      = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${PG_VERSION}/${fileName}`;

  const binRoot   = path.join(__dirname, '..', 'bin');
  const targetDir = path.join(binRoot, folderName);
  const pgRestore = path.join(targetDir, 'bin', process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore');

  log.info('═'.repeat(72));
  log.info('Setup PostgreSQL CLI portátil');
  log.info('═'.repeat(72));
  log.info(`Versão        : ${PG_VERSION}`);
  log.info(`Plataforma    : ${process.platform}-${process.arch} → ${triple}`);
  log.info(`Destino       : ${targetDir}`);

  if (!FLAG_FORCE && existsSync(pgRestore)) {
    const probe = spawnSync(pgRestore, ['--version'], { stdio: 'pipe' });
    if (probe.status === 0) {
      log.ok(`Já instalado: ${probe.stdout?.toString().trim()}`);
      log.info('Use --force pra reinstalar.');
      return;
    }
  }

  if (FLAG_FORCE && existsSync(targetDir)) {
    log.info(`--force: removendo ${targetDir}`);
    rmSync(targetDir, { recursive: true, force: true });
  }

  await mkdir(binRoot, { recursive: true });

  const tmp = path.join(tmpdir(), `pg-portable-${Date.now()}.${ext}`);
  try {
    await downloadWithProgress(url, tmp);
    extractZip(tmp, binRoot);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }

  if (!existsSync(pgRestore)) {
    throw new Error(`pg_restore não encontrado após extração: ${pgRestore}`);
  }

  const probe = spawnSync(pgRestore, ['--version'], { stdio: 'pipe' });
  if (probe.status !== 0) {
    throw new Error(`pg_restore não executa: ${probe.stderr?.toString()}`);
  }
  log.ok(`Instalado: ${probe.stdout?.toString().trim()}`);
  log.info('');
  log.info('Próximo passo:');
  log.info('  npm run test:sienge-backup -- --reuse   # reaproveita .dmpc já baixado');
  log.info('  npm run test:sienge-backup              # baixa tudo do zero');
}

main().catch(err => {
  log.error(err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
