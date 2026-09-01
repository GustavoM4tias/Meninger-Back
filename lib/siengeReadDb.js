// lib/siengeReadDb.js
//
// Conexão READ-ONLY ao backup diário do Sienge restaurado no Postgres dedicado
// (Railway, database `sie214801`). É o MESMO banco que o SiengeBackupService
// restaura todo dia via blue-green; aqui só lemos as tabelas nativas do Sienge
// (ecrcparcela, ecrctitulo, ...) para alimentar a tela de Inadimplência e a
// origem do TERRENO (ecrctitulo.deobservacao — ver services/bulkData/external/
// landService.js).
//
// Pool singleton (e não client de uso único) porque serve requisições web sob
// demanda além dos crons.
//
// A URL e os tetos do pool vêm da aba Configuração da tela Sienge
// (services/sienge/siengeConnection.js), com as env vars como piso. Trocar a
// conexão na tela derruba o pool aqui (resetSiengePool) para o próximo pedido
// já nascer no banco novo.
//
// TLS: a Railway distribui cert auto-assinado no Postgres; validamos com
// { rejectUnauthorized: false } — mesmo padrão do PG_CLIENT_OPTS em
// services/sienge/SiengeBackupService.js.

import pg from 'pg';
import dotenv from 'dotenv';
import { getConnection, readConnectionString } from '../services/sienge/siengeConnection.js';
dotenv.config();

let _pool = null;
let _poolKey = null;

/**
 * Piso síncrono, para o caso raro de alguém pegar o pool sem passar pelo
 * siengeQuery (que resolve a configuração antes). Mesma lógica de sempre:
 * SIENGE_PG_RESTORE_URL, senão SIENGE_PG_URL + SIENGE_PG_DATABASE.
 */
function envConnectionString() {
  const restore = process.env.SIENGE_PG_RESTORE_URL;
  if (restore) return restore;

  const base = process.env.SIENGE_PG_URL;
  if (!base) {
    throw new Error('Conexão de leitura do espelho Sienge não configurada (aba Configuração da tela Sienge).');
  }
  const db = process.env.SIENGE_PG_DATABASE || 'sie214801';
  const u = new URL(base);
  u.pathname = '/' + db;
  return u.toString();
}

function buildPool({ connectionString, max, statementTimeoutMs }) {
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs,
    application_name: 'menin-inadimplencia',
  });

  // Um erro num client ocioso não pode derrubar o processo. O swap diário do
  // restore (~05h) encerra conexões à força; o pool simplesmente reconecta.
  pool.on('error', (err) => {
    console.warn('[siengeReadDb] erro em client ocioso (ignorado):', err.message);
  });

  return pool;
}

/**
 * Garante que o pool existe e reflete a configuração em vigor. Trocar a URL,
 * o database ou os tetos na tela cria um pool novo e encerra o antigo em
 * segundo plano (as consultas em voo terminam antes).
 */
async function ensurePool() {
  let connectionString;
  let max;
  let statementTimeoutMs;
  try {
    const cfg = await getConnection();
    connectionString = await readConnectionString();
    max = cfg.read_pool_max;
    statementTimeoutMs = cfg.read_statement_timeout_ms;
  } catch (err) {
    if (_pool) return _pool;
    console.warn('[siengeReadDb] configuração indisponível, usando o .env:', err.message);
    connectionString = envConnectionString();
    max = Number(process.env.SIENGE_READ_POOL_MAX) || 4;
    statementTimeoutMs = Number(process.env.SIENGE_READ_STATEMENT_TIMEOUT_MS) || 60_000;
  }

  const key = `${connectionString}|${max}|${statementTimeoutMs}`;
  if (_pool && _poolKey === key) return _pool;

  const antigo = _pool;
  _pool = buildPool({ connectionString, max, statementTimeoutMs });
  _poolKey = key;
  if (antigo) antigo.end().catch(() => {});
  return _pool;
}

/**
 * O pool. Síncrono por compatibilidade: se ninguém ainda resolveu a
 * configuração, nasce do piso das env vars — e o primeiro `siengeQuery`
 * substitui-o pelo pool configurado.
 */
export function getSiengePool() {
  if (_pool) return _pool;
  const connectionString = envConnectionString();
  const max = Number(process.env.SIENGE_READ_POOL_MAX) || 4;
  const statementTimeoutMs = Number(process.env.SIENGE_READ_STATEMENT_TIMEOUT_MS) || 60_000;
  _pool = buildPool({ connectionString, max, statementTimeoutMs });
  _poolKey = `${connectionString}|${max}|${statementTimeoutMs}`;
  return _pool;
}

/** Derruba o pool para que o próximo pedido reconecte com a config nova. */
export async function resetSiengePool() {
  const antigo = _pool;
  _pool = null;
  _poolKey = null;
  if (antigo) await antigo.end().catch(() => {});
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
  const pool = await ensurePool();
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

export default { getSiengePool, siengeQuery, resetSiengePool };
