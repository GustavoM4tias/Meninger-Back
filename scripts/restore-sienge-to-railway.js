// scripts/restore-sienge-to-railway.js
//
// Restaura o dump .dmpc do Sienge num Postgres remoto (Railway), standalone.
// Espelha a fase de pg_restore do SiengeBackupService, mas sem Sequelize e
// com logging mais informativo (progresso por fase, ETA, banner de conclusão).
//
// Configuração:
//   - URL: SIENGE_PG_RESTORE_URL (proxy público) > SIENGE_PG_URL > --url=
//   - DB alvo: path da URL > --db= > SIENGE_PG_DATABASE > 'sie214801'
//
// Uso:
//   node scripts/restore-sienge-to-railway.js                       # default
//   node scripts/restore-sienge-to-railway.js --drop-first          # drop + create antes
//   node scripts/restore-sienge-to-railway.js --clean               # pg_restore --clean --if-exists
//   node scripts/restore-sienge-to-railway.js --jobs=8 --quiet
//   node scripts/restore-sienge-to-railway.js --url=... --dmpc=...

import { existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Railway distribui cert TLS auto-assinado. O driver `pg` do Node tenta
// validar a cadeia por default, o que falha com "self-signed certificate".
// Aqui estamos só restaurando dados — sslmode=require sem verificar CA é o
// equivalente ao comportamento do psql/pg_restore com o mesmo URL.
//
// Setado ANTES do import do pg pra garantir que o TLS layer veja.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import pg from 'pg';
import dotenv from 'dotenv';

// ── Setup ─────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(`--${name}=`.length) : null;
}
function bool(name) { return args.includes(`--${name}`); }

const URL_OVERRIDE  = flag('url');
const DB_OVERRIDE   = flag('db');
const DMPC_OVERRIDE = flag('dmpc');
const JOBS          = Number(flag('jobs') || process.env.SIENGE_PG_RESTORE_JOBS || 8);
const CLEAN         = bool('clean');
const DROP_FIRST    = bool('drop-first');
const QUIET         = bool('quiet');
const VERBOSE_PGRES = !bool('no-verbose'); // --verbose do pg_restore (pra captar fases)

// ── Logger ────────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 23); }
const log = {
  info:  (m) => console.log(`[${ts()}] ℹ  ${m}`),
  step:  (m) => console.log(`[${ts()}] ▶  ${m}`),
  ok:    (m) => console.log(`[${ts()}] ✅ ${m}`),
  warn:  (m) => console.warn(`[${ts()}] ⚠  ${m}`),
  error: (m) => console.error(`[${ts()}] ❌ ${m}`),
  pg:    (m) => console.log(`[${ts()}] 🐘 ${m}`),
};
function humanBytes(n) {
  if (n == null) return '?';
  const u = ['B','KB','MB','GB','TB']; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${u[i]}`;
}
function humanMs(ms) {
  if (ms == null || !isFinite(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${(s - m * 60).toFixed(0).padStart(2,'0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m - h * 60).toString().padStart(2,'0')}m`;
}

// ── Resolve config ────────────────────────────────────────────────────────────
function resolveUrls() {
  const base = URL_OVERRIDE || process.env.SIENGE_PG_RESTORE_URL || process.env.SIENGE_PG_URL;
  if (!base) {
    throw new Error('URL Postgres não configurada. Defina SIENGE_PG_RESTORE_URL no .env ou passe --url=...');
  }
  const u = new URL(base);
  const targetDb = DB_OVERRIDE
    || (u.pathname && u.pathname !== '/' ? u.pathname.replace(/^\//, '') : null)
    || process.env.SIENGE_PG_DATABASE
    || 'sie214801';

  const admin = new URL(base);
  admin.pathname = '/postgres';

  const target = new URL(base);
  target.pathname = '/' + targetDb;

  return { adminUrl: admin.toString(), targetUrl: target.toString(), targetDb, host: u.host };
}

function resolveDmpcPath() {
  if (DMPC_OVERRIDE) return path.resolve(DMPC_OVERRIDE);
  const dir = path.join(__dirname, '..', 'temp', 'sienge-backup-test');
  if (existsSync(dir)) {
    const files = readdirSync(dir)
      .filter(f => f.startsWith('sienge-') && f.endsWith('.dmpc'))
      .sort()
      .reverse();
    if (files.length) return path.join(dir, files[0]);
  }
  throw new Error(`.dmpc não encontrado. Rode \`npm run test:sienge-backup\` antes, ou passe --dmpc=<caminho>`);
}

function resolvePgRestore() {
  if (process.env.PG_RESTORE_BIN) return process.env.PG_RESTORE_BIN;
  const binDir = path.join(__dirname, '..', 'bin');
  if (existsSync(binDir)) {
    for (const entry of readdirSync(binDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(binDir, entry.name, 'bin', process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore');
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore';
}

// Equivalente a sslmode=require no libpq (encripta, não valida CA do Railway).
const PG_CLIENT_OPTS = (connectionString) => ({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// ── Cria/recria DB ────────────────────────────────────────────────────────────
async function ensureTargetDatabase(adminUrl, targetDb, dropFirst) {
  const client = new pg.Client(PG_CLIENT_OPTS(adminUrl));
  await client.connect();
  try {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(targetDb)) {
      throw new Error(`Nome de database inválido: ${targetDb}`);
    }
    if (dropFirst) {
      log.warn(`--drop-first: removendo "${targetDb}" se existir...`);
      await client.query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
      log.ok(`Database "${targetDb}" dropado (ou já não existia).`);
    }
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    if (r.rowCount === 0) {
      log.info(`Database "${targetDb}" não existe. Criando...`);
      await client.query(`CREATE DATABASE "${targetDb}"`);
      log.ok(`Database "${targetDb}" criado.`);
    } else {
      log.info(`Database "${targetDb}" já existe.`);
    }
  } finally {
    await client.end();
  }
}

// ── Snapshot do destino ───────────────────────────────────────────────────────
async function describeTarget(targetUrl) {
  const client = new pg.Client(PG_CLIENT_OPTS(targetUrl));
  await client.connect();
  try {
    const r = await client.query(`
      SELECT
        (SELECT count(*) FROM pg_tables  WHERE schemaname NOT IN ('pg_catalog','information_schema'))::int AS tables,
        (SELECT count(*) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema'))::int AS indexes,
        (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
           WHERE n.nspname NOT IN ('pg_catalog','information_schema'))::int AS constraints,
        pg_size_pretty(pg_database_size(current_database())) AS size,
        pg_database_size(current_database()) AS size_bytes
    `);
    return r.rows[0];
  } finally {
    await client.end();
  }
}

// ── Parse do TOC pra saber os totais por categoria ────────────────────────────
function parseTocCounts(pgBin, dmpcPath) {
  log.info(`Lendo TOC de ${dmpcPath} pra calcular totais...`);
  const r = spawnSync(pgBin, ['-l', dmpcPath], { stdio: 'pipe', maxBuffer: 200 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`pg_restore -l falhou (exit=${r.status}): ${r.stderr?.toString().slice(0,400)}`);
  }
  const out = r.stdout.toString();
  // Formato de cada linha: `id; oid id TIPO schema nome owner`
  // Exemplos: "1234; 1259 56789 TABLE DATA public.x postgres"
  //           "9012; 1259 67890 FK CONSTRAINT public.x x_fk postgres"
  const counts = {
    TABLE_DATA: 0,
    INDEX: 0,
    CONSTRAINT: 0,
    FK_CONSTRAINT: 0,
    TRIGGER: 0,
    SEQUENCE_SET: 0,
    OTHER: 0,
    TOTAL: 0,
  };
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    // Tipos compostos têm 2 palavras: "TABLE DATA", "FK CONSTRAINT", "SEQUENCE SET", "DEFAULT ACL"
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

// ── pg_restore com tracking por fase ──────────────────────────────────────────
function runPgRestore({ pgBin, dmpcPath, targetUrl, jobs, clean, totals }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-owner',
      '--no-privileges',
      '--no-acl',
      ...(clean ? ['--clean', '--if-exists'] : []),
      '--jobs', String(jobs),
      ...(VERBOSE_PGRES ? ['--verbose'] : []),
      '--dbname', targetUrl,
      dmpcPath,
    ];
    const argsForLog = args.map(a => a.replace(/:(?:[^:@/]+)@/, ':*****@'));
    log.info(`exec: ${pgBin} ${argsForLog.join(' ')}`);
    const startedAt = Date.now();
    const proc = spawn(pgBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const phases = {
      data:       { total: totals.TABLE_DATA,    done: 0, current: null, startedAt: null, finishedAt: null, label: 'tabela'      },
      index:      { total: totals.INDEX,         done: 0, current: null, startedAt: null, finishedAt: null, label: 'índice'      },
      constraint: { total: totals.CONSTRAINT,    done: 0, current: null, startedAt: null, finishedAt: null, label: 'constraint'  },
      fk:         { total: totals.FK_CONSTRAINT, done: 0, current: null, startedAt: null, finishedAt: null, label: 'FK'          },
      trigger:    { total: totals.TRIGGER,       done: 0, current: null, startedAt: null, finishedAt: null, label: 'trigger'     },
    };
    const errors = [];
    let killSent = false;
    let lastProgressLog = Date.now();
    const PROGRESS_EVERY_MS = QUIET ? 30000 : 5000;

    function markPhase(name, currentName) {
      const ph = phases[name];
      if (ph.startedAt === null) {
        ph.startedAt = Date.now();
        log.step(`── fase "${name}" iniciada (total esperado: ${ph.total})`);
      }
      ph.done++;
      ph.current = currentName;
    }

    function makeBar(done, total, width = 24) {
      if (total === 0) return '[' + '─'.repeat(width) + ']';
      const filled = Math.min(width, Math.round((done / total) * width));
      return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
    }
    function pct(done, total) {
      if (total === 0) return '  -%';
      return ((done / total) * 100).toFixed(1).padStart(4) + '%';
    }
    function etaFor(ph) {
      if (!ph.startedAt || ph.done === 0) return '?';
      const elapsed = Date.now() - ph.startedAt;
      const rate = ph.done / elapsed; // por ms
      const remaining = ph.total - ph.done;
      if (rate <= 0) return '?';
      return humanMs(remaining / rate);
    }

    function printProgress() {
      const totalElapsed = Date.now() - startedAt;

      // % geral: soma de itens concluídos / soma de totais (mesma unidade
      // de comparação dentro do TOC; aproxima sem ponderar por bytes).
      let doneAll = 0;
      let totalAll = 0;
      let etaAggMs = 0; // soma dos ETAs das fases pendentes
      const lines = [];
      for (const [name, p] of Object.entries(phases)) {
        if (p.total === 0) continue;
        doneAll  += p.done;
        totalAll += p.total;
        if (!p.finishedAt && p.startedAt && p.done > 0) {
          const elapsed = Date.now() - p.startedAt;
          const rate = p.done / elapsed;
          if (rate > 0) etaAggMs += (p.total - p.done) / rate;
        }
        const status = p.finishedAt ? '✓' : (p.startedAt ? '·' : ' ');
        const eta = p.finishedAt ? humanMs(p.finishedAt - p.startedAt) : `ETA ${etaFor(p)}`;
        const cur = p.finishedAt ? '' : (p.current ? ` · ${p.current}` : '');
        lines.push(`  ${status} ${name.padEnd(11)} ${makeBar(p.done, p.total)} ${pct(p.done, p.total)} (${p.done}/${p.total}) · ${eta}${cur}`);
      }
      const totalPct = totalAll === 0 ? '  -%' : ((doneAll / totalAll) * 100).toFixed(1).padStart(4) + '%';
      const totalBar = makeBar(doneAll, totalAll, 32);
      const totalEta = etaAggMs > 0 ? `ETA ~${humanMs(etaAggMs)}` : 'ETA ?';
      const header = `  TOTAL       ${totalBar} ${totalPct} (${doneAll}/${totalAll}) · ${totalEta}`;
      console.log(`\n[${ts()}] 📊 Progresso (decorrido: ${humanMs(totalElapsed)})\n${header}\n${'  '+'─'.repeat(60)}\n${lines.join('\n')}\n`);
    }

    function maybePrintProgress(force = false) {
      const now = Date.now();
      if (!force && now - lastProgressLog < PROGRESS_EVERY_MS) return;
      lastProgressLog = now;
      printProgress();
    }

    // Parsing das linhas de stderr (com --verbose o pg_restore emite muitos
    // tipos de mensagens diferentes — mapeamos os principais)
    let buffer = '';
    function flushLine(rawLine) {
      const line = rawLine.replace(/^pg_restore:\s*/i, '').trim();
      if (!line) return;

      // Data
      const mData = /^processing data for table\s+"([^"]+)"/i.exec(line);
      if (mData) return markPhase('data', mData[1]);

      // Index / Constraint / FK / Trigger — formato comum:
      //   creating INDEX "schema.name"
      //   creating CONSTRAINT "schema.tabela name"
      //   creating FK CONSTRAINT "schema.tabela name"
      //   creating TRIGGER "schema.tabela name"
      const mCreate = /^(?:creating|finished item \d+ \d+)\s+(INDEX|FK CONSTRAINT|CONSTRAINT|TRIGGER|SEQUENCE SET)\s+"?([^"]+)"?/i.exec(line);
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
        errors.push({ at: Date.now(), msg: line });
        if (errors.length <= 3 || errors.length % 200 === 0) {
          log.pg(`ERR (${errors.length}) ${line.slice(0, 300)}`);
        }
        // Detecção de cascata de erros (ex.: proxy derrubou todas as conexões).
        // Se >50 erros em 10s, aborta pg_restore — fica em loop infinito senão.
        const recent = errors.filter(e => Date.now() - e.at < 10_000).length;
        if (recent > 50 && !killSent) {
          killSent = true;
          log.error(`Cascata de erros detectada (${recent} em 10s). Matando pg_restore...`);
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
        return;
      }
      if (/^warning/i.test(line)) {
        // ruidoso, silencia (são esperados com --no-owner/--no-acl)
        return;
      }
      // outros ruídos (`launching workers`, `connecting to database`, `done`)
    }

    proc.stderr.on('data', chunk => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        flushLine(line);
      }
      // Detecta transição de fase pra fechar a anterior visualmente
      for (const ph of Object.values(phases)) {
        if (ph.startedAt && !ph.finishedAt && ph.done >= ph.total && ph.total > 0) {
          ph.finishedAt = Date.now();
          log.ok(`fase "${Object.entries(phases).find(([_, v]) => v === ph)[0]}" concluída em ${humanMs(ph.finishedAt - ph.startedAt)}`);
          maybePrintProgress(true);
        }
      }
      maybePrintProgress();
    });

    proc.on('error', err => reject(new Error(`Falha ao executar pg_restore: ${err.message}`)));
    proc.on('close', code => {
      if (buffer) flushLine(buffer);
      const elapsed = Date.now() - startedAt;
      // Marca fases não fechadas
      for (const ph of Object.values(phases)) {
        if (ph.startedAt && !ph.finishedAt) ph.finishedAt = Date.now();
      }
      maybePrintProgress(true);
      log.info(`pg_restore exit=${code} em ${humanMs(elapsed)} · erros=${errors.length}`);
      // 0 = success, 1 = warnings (esperado)
      if (code === 0 || code === 1) {
        return resolve({ exitCode: code, elapsedMs: elapsed, phases, errors });
      }
      const tail = errors.slice(-5).map(e => e.msg || e).join('\n');
      reject(new Error(`pg_restore saiu com código ${code} (erros: ${errors.length})\nÚltimos erros:\n${tail}`));
    });
  });
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function main() {
  const overallStart = Date.now();
  log.info('═'.repeat(72));
  log.info('Sienge → Railway: restore manual');
  log.info('═'.repeat(72));

  const { adminUrl, targetUrl, targetDb, host } = resolveUrls();
  const dmpcPath = resolveDmpcPath();
  const pgBin    = resolvePgRestore();

  const probe = spawnSync(pgBin, ['--version'], { stdio: 'pipe' });
  if (probe.status !== 0) {
    throw new Error(`pg_restore não executa em ${pgBin}. Rode \`npm run setup:pg-tools\` antes.`);
  }
  log.info(`pg_restore     : ${probe.stdout.toString().trim()} (${pgBin})`);
  log.info(`host           : ${host}`);
  log.info(`database alvo  : ${targetDb}`);
  log.info(`dump (.dmpc)   : ${dmpcPath}`);
  log.info(`jobs paralelos : ${JOBS}`);
  log.info(`flags          : ${[CLEAN && '--clean --if-exists', DROP_FIRST && '--drop-first'].filter(Boolean).join(' ') || '(sem clean, sem drop)'}`);
  log.info('─'.repeat(72));

  const totals = parseTocCounts(pgBin, dmpcPath);
  log.info(`TOC entries por categoria:`);
  log.info(`  TABLE DATA    : ${totals.TABLE_DATA}`);
  log.info(`  INDEX         : ${totals.INDEX}`);
  log.info(`  CONSTRAINT    : ${totals.CONSTRAINT}`);
  log.info(`  FK CONSTRAINT : ${totals.FK_CONSTRAINT}`);
  log.info(`  TRIGGER       : ${totals.TRIGGER}`);
  log.info(`  SEQUENCE SET  : ${totals.SEQUENCE_SET}`);
  log.info(`  outros        : ${totals.OTHER}`);
  log.info(`  TOTAL         : ${totals.TOTAL}`);
  log.info('─'.repeat(72));

  await ensureTargetDatabase(adminUrl, targetDb, DROP_FIRST);

  const before = await describeTarget(targetUrl);
  log.info(`Antes do restore : ${before.tables} tabelas · ${before.indexes} índices · ${before.constraints} constraints · ${before.size}`);
  log.info('─'.repeat(72));

  let result;
  let restoreFailed = null;
  try {
    result = await runPgRestore({ pgBin, dmpcPath, targetUrl, jobs: JOBS, clean: CLEAN, totals });
  } catch (e) {
    restoreFailed = e;
  }

  const after = await describeTarget(targetUrl);
  const totalMs = Date.now() - overallStart;

  // Banner final
  const ok = !restoreFailed;
  const line = '═'.repeat(72);
  console.log('');
  console.log(line);
  console.log(ok ? '   ✅ RESTORE CONCLUÍDO' : '   ❌ RESTORE FALHOU');
  console.log(line);
  console.log(`  Database : ${targetDb} @ ${host}`);
  console.log(`  Tabelas  : ${before.tables} → ${after.tables} (esperado ${totals.TABLE_DATA + 0})`);
  console.log(`  Índices  : ${before.indexes} → ${after.indexes} (esperado ${totals.INDEX})`);
  console.log(`  Constr.  : ${before.constraints} → ${after.constraints}`);
  console.log(`  Tamanho  : ${before.size} → ${after.size}`);
  if (result) {
    console.log(`  Fases:`);
    for (const [name, ph] of Object.entries(result.phases)) {
      if (ph.total === 0) continue;
      const done = ph.done;
      const ok = done >= ph.total;
      const dur = ph.startedAt && ph.finishedAt ? humanMs(ph.finishedAt - ph.startedAt) : '-';
      console.log(`    ${ok ? '✓' : '✗'} ${name.padEnd(11)} ${done}/${ph.total}  em ${dur}`);
    }
    console.log(`  Erros pg_restore: ${result.errors.length}`);
    if (result.errors.length) {
      console.log(`  Últimos erros:`);
      for (const e of result.errors.slice(-5)) console.log(`    · ${(e.msg || e).slice(0, 200)}`);
    }
  }
  console.log(`  Total: ${humanMs(totalMs)}`);
  console.log(line);

  if (restoreFailed) throw restoreFailed;
}

main().catch(err => {
  log.error(`Falhou: ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
