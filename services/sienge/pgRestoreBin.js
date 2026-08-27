// services/sienge/pgRestoreBin.js
//
// Resolve o binário do pg_restore sem depender do PATH do sistema.
//
// Motivo: o pipeline diário falhava com `spawn pg_restore ENOENT` em 39% das
// rodadas porque o processo contava com o PATH. Pior: o ENOENT só aparecia
// DEPOIS de o pipeline já ter dropado e recriado o database de staging, o que
// destruía a restauração que outra instância estava fazendo naquele momento.
//
// Aqui a resolução é explícita e provada (`--version`) antes de qualquer coisa
// ser tocada no Postgres. A mesma lógica já existia em
// scripts/restore-sienge-to-railway.js; esta é a versão compartilhada e
// ampliada com os caminhos típicos de Linux (Railway/nixpacks).

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.join(__dirname, '..', '..');

const EXE = process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore';

/** Diretórios onde distribuições de Linux costumam deixar os binários do client. */
const LINUX_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'];

/** Raízes com uma pasta por versão: /usr/lib/postgresql/17/bin/pg_restore */
const LINUX_VERSIONED_ROOTS = ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/postgresql'];

function candidateFromDir(dir) {
  const p = path.join(dir, EXE);
  return existsSync(p) ? p : null;
}

/** Meninger-Back/bin/postgresql-<versão>-<triple>/bin/pg_restore — vem do
 *  scripts/setup-pg-tools.js, que o build do Railway roda. */
function scanLocalBinDir() {
  const binDir = path.join(ROOT_DIR, 'bin');
  if (!existsSync(binDir)) return null;
  try {
    for (const entry of readdirSync(binDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const hit = candidateFromDir(path.join(binDir, entry.name, 'bin'));
      if (hit) return hit;
    }
  } catch { /* diretório ilegível: segue pros próximos candidatos */ }
  return null;
}

function scanVersionedRoots() {
  for (const root of LINUX_VERSIONED_ROOTS) {
    if (!existsSync(root)) continue;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    // Maior versão primeiro (17 antes de 15) — o dump do Sienge é Postgres 17.
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
      .sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0));
    for (const d of dirs) {
      const hit = candidateFromDir(path.join(root, d, 'bin'));
      if (hit) return hit;
    }
  }
  return null;
}

/** /nix/store/<hash>-postgresql-17.x/bin/pg_restore — o layout do nixpacks.
 *  A pasta tem milhares de entradas, então é o último lugar em que olhamos. */
function scanNixStore() {
  const store = '/nix/store';
  if (!existsSync(store)) return null;
  try {
    const dirs = readdirSync(store).filter(n => /postgresql/i.test(n) && !n.endsWith('.drv'));
    for (const d of dirs.sort().reverse()) {
      const hit = candidateFromDir(path.join(store, d, 'bin'));
      if (hit) return hit;
    }
  } catch { /* store ilegível: cai pro PATH */ }
  return null;
}

/**
 * Devolve o caminho do pg_restore. Ordem:
 *   1. PG_RESTORE_BIN (escape hatch de operação)
 *   2. bin/ da própria aplicação (baixado pelo setup-pg-tools no build)
 *   3. caminhos versionados de Linux
 *   4. /usr/local/bin, /usr/bin, /bin
 *   5. /nix/store
 *   6. o nome solto, deixando o PATH resolver
 *
 * Nunca lança: quem precisa de garantia usa probePgRestore().
 */
export function resolvePgRestore() {
  const override = process.env.PG_RESTORE_BIN;
  if (override) return override;

  return scanLocalBinDir()
    || scanVersionedRoots()
    || LINUX_BIN_DIRS.map(candidateFromDir).find(Boolean)
    || scanNixStore()
    || EXE;
}

let _probed = null;

/**
 * Resolve E prova o binário rodando `--version`. Cacheia o resultado por
 * processo (o binário não muda em runtime).
 *
 * Lança com mensagem acionável se não achar — é o que segura o pipeline no
 * stage de preflight, antes de o staging ser tocado.
 */
export function probePgRestore({ force = false } = {}) {
  if (_probed && !force) return _probed;

  const bin = resolvePgRestore();
  const r = spawnSync(bin, ['--version'], { stdio: 'pipe', timeout: 15_000 });

  if (r.error || r.status !== 0) {
    const detail = r.error?.message || r.stderr?.toString().trim() || `exit=${r.status}`;
    throw new Error(
      `pg_restore não está disponível (tentei "${bin}"): ${detail}. `
      + 'Configure PG_RESTORE_BIN ou rode `npm run setup:pg-tools` no ambiente.'
    );
  }

  _probed = { bin, version: r.stdout.toString().trim() };
  return _probed;
}

export default { resolvePgRestore, probePgRestore };
