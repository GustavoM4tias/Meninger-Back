// lib/siengeBackupLock.js
//
// Trava distribuída da carga diária do Sienge.
//
// Por que existe: o histórico de `sienge_backup_logs` mostra 18 dias em que
// DUAS instâncias do Office dispararam o cron no mesmo segundo. O pipeline
// dropa e recria o database `sie214801_staging` sem exclusão mútua nenhuma, de
// modo que a segunda instância arrancava o staging debaixo da primeira. Os três
// modos de falha conhecidos (`spawn pg_restore ENOENT`, `cascata de N erros`,
// `database "sie214801_staging" does not exist`) são consequência disso.
//
// A trava é um advisory lock de SESSÃO no Postgres do Office. Vale entre
// processos e entre containers, porque o banco é o mesmo — não importa se a
// segunda instância é réplica do Railway, outro serviço ou um deploy sobreposto.
//
// Precisa de uma conexão dedicada: o lock vive na sessão, e uma conexão do pool
// do Sequelize volta pro pool e é reaproveitada por qualquer outra query.

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Chave fixa do lock. Dois inteiros (classe, objeto) pra não colidir com outro
// advisory lock que venha a existir no mesmo banco.
const LOCK_CLASS = 0x5138;  // "sienge"
const LOCK_KEY   = 1;       // backup diário

const KEEPALIVE_MS = 60_000;

function buildClient() {
  return new pg.Client({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    application_name: 'sienge-backup-lock',
  });
}

/**
 * Identidade desta instância. Vai pro log da rodada pra que a próxima
 * investigação saiba de qual container veio cada tentativa — hoje isso não é
 * registrado em lugar nenhum e foi preciso deduzir pelos stage_timings.
 */
export function instanceId() {
  const parts = [
    process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_SERVICE_NAME || process.env.HOSTNAME,
    `pid${process.pid}`,
  ].filter(Boolean);
  return parts.join('/').slice(0, 120);
}

/**
 * Tenta pegar a trava. Devolve `null` se outra rodada já está com ela (não
 * espera — a rodada seguinte é do vigia, não faz sentido enfileirar).
 *
 * O objeto devolvido tem `release()`; chame sempre em `finally`.
 */
export async function acquireBackupLock() {
  const client = buildClient();
  await client.connect();

  let got;
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_CLASS, LOCK_KEY]);
    got = r.rows[0]?.ok === true;
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }

  if (!got) {
    await client.end().catch(() => {});
    return null;
  }

  // A rodada dura 20+ minutos. Sem tráfego, o proxy do Railway derruba a
  // sessão ociosa — e derrubar a sessão solta o lock em silêncio.
  const keepalive = setInterval(() => {
    client.query('SELECT 1').catch(err => {
      console.warn('[siengeBackupLock] keepalive falhou:', err.message);
    });
  }, KEEPALIVE_MS);
  keepalive.unref?.();

  return {
    async release() {
      clearInterval(keepalive);
      // `end()` encerra a sessão e solta o lock junto; o unlock explícito é só
      // pra soltar mais cedo caso o end() demore.
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, LOCK_KEY]).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/**
 * Roda `fn` com a trava. Se outra rodada está com ela, chama `onBusy` (se
 * houver) e devolve `{ locked: false }` sem executar nada.
 */
export async function withBackupLock(fn, { onBusy } = {}) {
  const lock = await acquireBackupLock();
  if (!lock) {
    if (onBusy) await onBusy();
    return { locked: false };
  }
  try {
    return { locked: true, result: await fn() };
  } finally {
    await lock.release();
  }
}

export default { acquireBackupLock, withBackupLock, instanceId };
