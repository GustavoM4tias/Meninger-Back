// lib/siengeReadDb.js
//
// Conexão READ-ONLY ao backup diário do Sienge restaurado no Postgres dedicado
// (Railway, database `sie214801`). É o MESMO banco que o SiengeBackupService
// restaura todo dia via blue-green; aqui só lemos as tabelas nativas do Sienge
// (ecrcparcela, ecrctitulo, ...) para alimentar a tela de Inadimplência.
//
// Diferente do `lib/extDb.js` (pg.Client de uso único p/ o cron de obstit), aqui
// usamos um pg.Pool singleton porque serve requisições web sob demanda.
//
// TLS: a Railway distribui cert auto-assinado no Postgres; validamos com
// { rejectUnauthorized: false } — mesmo padrão do PG_CLIENT_OPTS em
// services/sienge/SiengeBackupService.js.

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const STATEMENT_TIMEOUT_MS = Number(process.env.SIENGE_READ_STATEMENT_TIMEOUT_MS || 60_000);

let _pool = null;

/**
 * Resolve a URL de conexão do backup. Prioriza SIENGE_PG_RESTORE_URL (já vem com
 * o database no path). Se faltar, monta a partir de SIENGE_PG_URL + SIENGE_PG_DATABASE
 * (mesma lógica do buildPgUrls do SiengeBackupService).
 */
function resolveConnectionString() {
  const restore = process.env.SIENGE_PG_RESTORE_URL;
  if (restore) return restore;

  const base = process.env.SIENGE_PG_URL;
  if (!base) {
    throw new Error('SIENGE_PG_RESTORE_URL (ou SIENGE_PG_URL) não configurada para a leitura do backup Sienge.');
  }
  const db = process.env.SIENGE_PG_DATABASE || 'sie214801';
  const u = new URL(base);
  u.pathname = '/' + db;
  return u.toString();
}

export function getSiengePool() {
  if (_pool) return _pool;

  _pool = new pg.Pool({
    connectionString: resolveConnectionString(),
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.SIENGE_READ_POOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'menin-inadimplencia',
  });

  // Um erro num client ocioso não pode derrubar o processo. O swap diário do
  // restore (~05h) encerra conexões à força; o pool simplesmente reconecta.
  _pool.on('error', (err) => {
    console.warn('[siengeReadDb] erro em client ocioso (ignorado):', err.message);
  });

  return _pool;
}

function isConnectionError(err) {
  const code = err?.code || '';
  return /ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|57P01|08006|08003|08000|XX000/i.test(
    `${code} ${err?.message || ''}`
  );
}

/**
 * Executa uma query no backup Sienge. Faz 1 retry em erro de conexão (cobre a
 * janela curta do swap diário do restore, quando as conexões caem).
 */
export async function siengeQuery(text, params = []) {
  const pool = getSiengePool();
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (isConnectionError(err)) {
      console.warn('[siengeReadDb] retry após erro de conexão:', err.message);
      return await pool.query(text, params);
    }
    throw err;
  }
}

export default { getSiengePool, siengeQuery };
