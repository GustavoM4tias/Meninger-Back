// Self-test do ciclo snapshot→wipe→replay das views custom. Cria uma view
// throwaway como sienge_readonly, valida persistência, e limpa tudo no fim.
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
import { snapshotCustomViews, applyCustomViews } from './services/sienge/siengeCustomViews.js';

const TEST_VIEW = '_meninger_persist_selftest';

const targetUrl = process.env.SIENGE_PG_RESTORE_URL; // → sie214801
const adminU = new URL(process.env.SIENGE_PG_URL);
adminU.pathname = '/postgres';
const storeUrl = adminU.toString(); // → database postgres (store)

const opts = (cs) => ({ connectionString: cs, ssl: { rejectUnauthorized: false } });
const q = async (cs, sql, p = []) => {
  const c = new pg.Client(opts(cs));
  await c.connect();
  try { return await c.query(sql, p); } finally { await c.end().catch(() => {}); }
};
const ownerOf = async (name) => {
  const r = await q(targetUrl, `SELECT viewowner FROM pg_views WHERE schemaname='public' AND viewname=$1`, [name]);
  return r.rows[0]?.viewowner || null;
};

let pass = true;
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) pass = false; };

async function createAsReadonly() {
  const c = new pg.Client(opts(targetUrl));
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE "sienge_readonly"');
    await c.query(`CREATE OR REPLACE VIEW public."${TEST_VIEW}" AS SELECT 1 AS ok`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { await c.end().catch(() => {}); }
}

try {
  console.log('targetUrl db:', new URL(targetUrl).pathname, '| storeUrl db:', adminU.pathname, '\n');

  // 1. Marcus cria a view ao vivo
  await createAsReadonly();
  check('view criada com dono sienge_readonly', (await ownerOf(TEST_VIEW)) === 'sienge_readonly');

  // 2. Snapshot (antes do "swap")
  const snap = await snapshotCustomViews({ prodUrl: targetUrl, storeUrl });
  check(`snapshot capturou a view (count=${snap.count} >= 1)`, snap.count >= 1);
  const inStore = await q(storeUrl, `SELECT 1 FROM public.sienge_custom_views WHERE viewname=$1`, [TEST_VIEW]);
  check('view presente no store (database postgres)', inStore.rowCount === 1);

  // 3. Simula o restore: dropa a view do banco
  await q(targetUrl, `DROP VIEW IF EXISTS public."${TEST_VIEW}"`);
  check('view sumiu após "restore" (drop)', (await ownerOf(TEST_VIEW)) === null);

  // 4. Replay (depois do "swap"+grants)
  const res = await applyCustomViews({ targetUrl, storeUrl });
  check(`replay recriou (created=${res.created}, failed=${res.failed.length})`, res.created >= 1 && res.failed.length === 0);
  check('view de volta com dono sienge_readonly', (await ownerOf(TEST_VIEW)) === 'sienge_readonly');
  const sel = await q(targetUrl, `SELECT ok FROM public."${TEST_VIEW}"`);
  check('view consultável (SELECT ok = 1)', sel.rows[0]?.ok === 1);
} catch (e) {
  console.error('\nERRO no self-test:', e.message);
  pass = false;
} finally {
  // Cleanup: dropa a view de teste e re-espelha o store (remove o registro de teste)
  await q(targetUrl, `DROP VIEW IF EXISTS public."${TEST_VIEW}"`).catch(() => {});
  await snapshotCustomViews({ prodUrl: targetUrl, storeUrl }).catch(() => {});
  const leftover = await q(storeUrl, `SELECT count(*)::int n FROM public.sienge_custom_views WHERE viewname=$1`, [TEST_VIEW]).catch(() => ({ rows: [{ n: -1 }] }));
  console.log(`\ncleanup: registro de teste no store = ${leftover.rows[0].n} (esperado 0)`);
  console.log(pass ? '\n==> SELF-TEST OK' : '\n==> SELF-TEST FALHOU');
  process.exitCode = pass ? 0 : 1;
}
