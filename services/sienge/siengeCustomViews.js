// services/sienge/siengeCustomViews.js
//
// Persistência das VIEWs criadas AO VIVO pelo usuário read-only (sienge_readonly)
// no backup do Sienge. O banco `sie214801` é recriado todo dia pelo swap
// blue-green (SiengeBackupService), então qualquer view que o Marcus/BI criar lá
// some no próximo restore.
//
// Estratégia (fonte da verdade = o que está vivo no banco):
//   1. ANTES do swap: snapshot das views que o sienge_readonly criou (espelho
//      completo) numa tabela no database `postgres` — MESMA instância Postgres,
//      que nunca é dropada pelo swap.
//   2. DEPOIS do swap (e depois do applyGrants): recria essas views no banco
//      novo, com dono sienge_readonly, em multi-pass pra resolver dependências
//      entre views.
//
// O Marcus cria/edita/dropa views à vontade direto no banco; o snapshot do
// próximo backup reflete o estado atual (view dropada some do store).

import pg from 'pg';

const READONLY_ROLE = process.env.SIENGE_READONLY_ROLE || 'sienge_readonly';
// Tabela de snapshot, no schema public do database `postgres` (storeUrl).
const STORE_TABLE = 'sienge_custom_views';

// Railway usa cert TLS auto-assinado — encripta mas não valida CA (mesmo padrão
// do PG_CLIENT_OPTS do SiengeBackupService e do lib/siengeReadDb.js).
const clientOpts = (connectionString) => ({ connectionString, ssl: { rejectUnauthorized: false } });

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function withClient(connectionString, fn) {
  const client = new pg.Client(clientOpts(connectionString));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Cria a tabela de snapshot (idempotente) no database `postgres` (storeUrl). */
export async function ensureViewStore(storeUrl) {
  await withClient(storeUrl, (c) =>
    c.query(`
      CREATE TABLE IF NOT EXISTS public.${STORE_TABLE} (
        viewname    text PRIMARY KEY,
        definition  text NOT NULL,
        ord         int  NOT NULL DEFAULT 0,
        captured_at timestamptz NOT NULL DEFAULT now()
      )
    `)
  );
}

/**
 * Lê as views do sienge_readonly no banco vivo (prodUrl) e espelha na tabela de
 * snapshot (storeUrl). Espelho completo: views dropadas pelo Marcus saem do store.
 *
 * Best-effort no chamador: se isto lançar, o backup mantém o snapshot anterior
 * (degradação graciosa — recria as views da véspera em vez de perder tudo).
 *
 * @returns {Promise<{count:number}>}
 */
export async function snapshotCustomViews({ prodUrl, storeUrl }) {
  await ensureViewStore(storeUrl);

  const views = await withClient(prodUrl, async (c) => {
    const r = await c.query(
      `SELECT c.relname AS viewname,
              pg_get_viewdef(c.oid, true) AS definition
         FROM pg_class     c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles     r ON r.oid = c.relowner
        WHERE c.relkind = 'v' AND n.nspname = 'public' AND r.rolname = $1
        ORDER BY c.oid`,
      [READONLY_ROLE]
    );
    return r.rows;
  });

  await withClient(storeUrl, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`TRUNCATE public.${STORE_TABLE}`);
      let ord = 0;
      for (const v of views) {
        await c.query(
          `INSERT INTO public.${STORE_TABLE} (viewname, definition, ord, captured_at)
           VALUES ($1, $2, $3, now())`,
          [v.viewname, v.definition, ord++]
        );
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });

  return { count: views.length };
}

/**
 * Recria no banco recém-promovido (targetUrl) as views guardadas no snapshot
 * (storeUrl), com dono sienge_readonly. Multi-pass: resolve dependência entre
 * views (uma view que usa outra) sem precisar de ordenação topológica explícita.
 * Best-effort por view — registra as que não subirem sem abortar o restore.
 *
 * PRÉ-REQUISITO: applyGrants já rodou neste banco (sienge_readonly precisa de
 * CREATE em public + SELECT nas tabelas base).
 *
 * @returns {Promise<{created:number,total:number,failed:Array<{viewname:string,error:string}>}>}
 */
export async function applyCustomViews({ targetUrl, storeUrl }) {
  await ensureViewStore(storeUrl);

  const rows = await withClient(storeUrl, async (c) => {
    const r = await c.query(
      `SELECT viewname, definition FROM public.${STORE_TABLE} ORDER BY ord, viewname`
    );
    return r.rows;
  });

  if (rows.length === 0) return { created: 0, total: 0, failed: [] };

  const quotedRole = quoteIdent(READONLY_ROLE);

  return withClient(targetUrl, async (c) => {
    let pending = rows.slice();
    let created = 0;
    const lastErrors = {};

    // No pior caso (cadeia linear de dependências) precisa de N passes.
    const maxPasses = Math.min(pending.length, 25);
    for (let pass = 0; pass < maxPasses && pending.length; pass++) {
      const stillPending = [];
      for (const v of pending) {
        try {
          // SET LOCAL ROLE dentro da txn → a view nasce com dono sienge_readonly
          // (mantém o filtro do snapshot funcionando no próximo backup) e reseta
          // sozinho no COMMIT/ROLLBACK.
          await c.query('BEGIN');
          await c.query(`SET LOCAL ROLE ${quotedRole}`);
          await c.query(`CREATE OR REPLACE VIEW public.${quoteIdent(v.viewname)} AS\n${v.definition}`);
          await c.query('COMMIT');
          created++;
          delete lastErrors[v.viewname];
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          lastErrors[v.viewname] = e.message;
          stillPending.push(v);
        }
      }
      if (stillPending.length === pending.length) break; // pass sem progresso → para
      pending = stillPending;
    }

    const failed = pending.map((v) => ({ viewname: v.viewname, error: lastErrors[v.viewname] }));
    return { created, total: rows.length, failed };
  });
}

export default { ensureViewStore, snapshotCustomViews, applyCustomViews };
