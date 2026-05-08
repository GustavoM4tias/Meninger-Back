// services/sienge/SiengeBackupService.js
// Pipeline diário de backup do banco Sienge:
//   FASE 1: baixa o .dmpc.gz da API Sienge → valida MD5 → descomprime e sobe no
//           bucket Oracle Cloud
//   FASE 2: dispara impdp via ORDS REST no Autonomous DB → faz polling até
//           concluir → ao terminar com sucesso, apaga backups antigos do bucket
//
// Cada etapa atualiza o registro em sienge_backup_logs.

import { createWriteStream, createReadStream } from 'node:fs';
import { unlink, mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import axios from 'axios';

import db from '../../models/sequelize/index.js';

// ── Sienge ────────────────────────────────────────────────────────────────────
const SIENGE_USER     = process.env.SIENGE_BACKUP_USER;
const SIENGE_PASSWORD = process.env.SIENGE_BACKUP_PASSWORD;
const SIENGE_URL      = process.env.SIENGE_BACKUP_URL;
const SIENGE_MD5_URL  = process.env.SIENGE_BACKUP_MD5_URL;

// ── Oracle Cloud Object Storage (S3 compat) ───────────────────────────────────
const OCI_NAMESPACE     = process.env.OCI_NAMESPACE;
const OCI_REGION        = process.env.OCI_REGION || 'sa-saopaulo-1';
const OCI_BUCKET        = process.env.OCI_BUCKET || 'sienge-backups';
const OCI_S3_ACCESS_KEY = process.env.OCI_S3_ACCESS_KEY;
const OCI_S3_SECRET_KEY = process.env.OCI_S3_SECRET_KEY;

// ── Oracle Autonomous Database (ORDS REST) ────────────────────────────────────
const ORACLE_ORDS_URL          = process.env.ORACLE_ORDS_URL;            // ex: https://g03969e302e6e85-siengedb.adb.sa-saopaulo-1.oraclecloudapps.com/ords/
const ORACLE_ADMIN_USER        = process.env.ORACLE_ADMIN_USER || 'ADMIN';
const ORACLE_ADMIN_PASSWORD    = process.env.ORACLE_ADMIN_PASSWORD;
const ORACLE_BACKUP_CREDENTIAL = process.env.ORACLE_BACKUP_CREDENTIAL || 'OCI_BACKUP_CRED';
const AUTO_IMPORT_ENABLED      = process.env.ENABLE_SIENGE_AUTO_IMPORT !== 'false'; // default ON
const IMPORT_POLL_INTERVAL_MS  = Number(process.env.SIENGE_IMPORT_POLL_INTERVAL_MS || 15000);
const IMPORT_TIMEOUT_MS        = Number(process.env.SIENGE_IMPORT_TIMEOUT_MS || 90 * 60 * 1000); // 90 min

const TMP_DIR = path.join(tmpdir(), 'sienge-backup');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function basicAuthHeader(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

function siengeAuthHeader() {
  return basicAuthHeader(SIENGE_USER, SIENGE_PASSWORD);
}

function ociS3Client() {
  if (!OCI_NAMESPACE || !OCI_S3_ACCESS_KEY || !OCI_S3_SECRET_KEY) {
    throw new Error('Variáveis OCI_NAMESPACE / OCI_S3_ACCESS_KEY / OCI_S3_SECRET_KEY não configuradas');
  }
  return new S3Client({
    region: OCI_REGION,
    endpoint: `https://${OCI_NAMESPACE}.compat.objectstorage.${OCI_REGION}.oraclecloud.com`,
    credentials: {
      accessKeyId: OCI_S3_ACCESS_KEY,
      secretAccessKey: OCI_S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

function bucketObjectUri(objectKey) {
  // Formato URI nativo do OCI Object Storage que o DBMS_CLOUD/DBMS_DATAPUMP entende
  return `https://objectstorage.${OCI_REGION}.oraclecloud.com/n/${OCI_NAMESPACE}/b/${OCI_BUCKET}/o/${objectKey}`;
}

// ─── Sienge download ──────────────────────────────────────────────────────────

async function fetchExpectedMd5() {
  const res = await fetch(SIENGE_MD5_URL, { headers: { Authorization: siengeAuthHeader() } });
  if (!res.ok) throw new Error(`MD5 endpoint retornou ${res.status} ${res.statusText}`);
  const text = (await res.text()).trim();
  return text.split(/\s+/)[0].toLowerCase();
}

async function downloadAndHash(localPath) {
  const res = await fetch(SIENGE_URL, { headers: { Authorization: siengeAuthHeader() } });
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

// ─── Bucket upload + cleanup ──────────────────────────────────────────────────

async function uploadDecompressedToBucket(gzPath, objectKey) {
  const s3 = ociS3Client();
  const fileStream = createReadStream(gzPath);
  const decompressed = fileStream.pipe(createGunzip());

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: OCI_BUCKET,
      Key: objectKey,
      Body: decompressed,
      ContentType: 'application/octet-stream',
    },
    queueSize: 4,
    partSize: 50 * 1024 * 1024,
  });

  await upload.done();
}

async function deleteOtherBackupsInBucket(currentObjectKey, prefix = 'daily/') {
  const s3 = ociS3Client();
  let count = 0;
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: OCI_BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    const toDelete = (list.Contents || [])
      .filter(o => o.Key && o.Key !== currentObjectKey)
      .map(o => ({ Key: o.Key }));
    if (toDelete.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: OCI_BUCKET,
        Delete: { Objects: toDelete, Quiet: true },
      }));
      count += toDelete.length;
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return count;
}

// ─── Oracle ORDS REST ─────────────────────────────────────────────────────────

function ordsAuth() {
  return { username: ORACLE_ADMIN_USER, password: ORACLE_ADMIN_PASSWORD };
}

function ordsSqlEndpoint() {
  if (!ORACLE_ORDS_URL) throw new Error('ORACLE_ORDS_URL não configurada');
  const base = ORACLE_ORDS_URL.endsWith('/') ? ORACLE_ORDS_URL : ORACLE_ORDS_URL + '/';
  // Endpoint padrão de SQL pra usuário schema-aware do ORDS
  return `${base}${ORACLE_ADMIN_USER.toLowerCase()}/_/sql`;
}

async function runOrdsSql(statementText) {
  const res = await axios.post(
    ordsSqlEndpoint(),
    { statementText },
    {
      auth: ordsAuth(),
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
      validateStatus: () => true,
    },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`ORDS retornou ${res.status}: ${JSON.stringify(res.data).slice(0, 500)}`);
  }
  return res.data;
}

// ─── Fase 2: import via DBMS_DATAPUMP ─────────────────────────────────────────

function buildImportPlsql(jobName, fileUri) {
  return `
DECLARE
  v_handle NUMBER;
BEGIN
  v_handle := DBMS_DATAPUMP.OPEN(
    operation => 'IMPORT',
    job_mode  => 'FULL',
    job_name  => '${jobName}'
  );
  DBMS_DATAPUMP.ADD_FILE(
    handle    => v_handle,
    filename  => '${fileUri}',
    directory => '${ORACLE_BACKUP_CREDENTIAL}',
    filetype  => DBMS_DATAPUMP.KU$_FILE_TYPE_URIDUMP_FILE
  );
  DBMS_DATAPUMP.SET_PARAMETER(
    handle => v_handle,
    name   => 'TABLE_EXISTS_ACTION',
    value  => 'REPLACE'
  );
  DBMS_DATAPUMP.START_JOB(v_handle);
  DBMS_DATAPUMP.DETACH(v_handle);
END;
`.trim();
}

async function fetchImportJobState(jobName) {
  const sql = `
SELECT state AS "state", attached_sessions AS "attached_sessions"
FROM DBA_DATAPUMP_JOBS
WHERE job_name = '${jobName}' AND owner_name = '${ORACLE_ADMIN_USER}'
`.trim();
  const data = await runOrdsSql(sql);
  const items = data?.items?.[0]?.resultSet?.items
              ?? data?.items?.[0]?.items
              ?? [];
  if (!items.length) return null; // Job sumiu da view = concluiu (com sucesso ou erro)
  const row = items[0];
  return {
    state: row.state ?? row.STATE,
    attached_sessions: row.attached_sessions ?? row.ATTACHED_SESSIONS,
  };
}

async function findLatestBucketObject(prefix = 'daily/') {
  const s3 = ociS3Client();
  let latest = null;
  let token;
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: OCI_BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const o of (list.Contents || [])) {
      if (!latest || (o.LastModified && o.LastModified > latest.LastModified)) latest = o;
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return latest?.Key || null;
}

async function importIntoOracleDB(objectKey, log) {
  const jobName = ('IMP_SIENGE_' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)).slice(0, 30);
  const fileUri = bucketObjectUri(objectKey);

  await log.update({
    import_status: 'running',
    import_job_name: jobName,
    import_started_at: new Date(),
    stage: 'importing',
  });

  // Dispara o job (DBMS_DATAPUMP.START_JOB é não-bloqueante)
  await runOrdsSql(buildImportPlsql(jobName, fileUri));

  const startedAt = Date.now();
  while (Date.now() - startedAt < IMPORT_TIMEOUT_MS) {
    await sleep(IMPORT_POLL_INTERVAL_MS);
    const row = await fetchImportJobState(jobName);
    if (!row) {
      // Sumiu da DBA_DATAPUMP_JOBS = terminou (com ou sem erro)
      const finishedAt = new Date();
      await log.update({
        import_status: 'success',
        import_finished_at: finishedAt,
        import_duration_ms: finishedAt - new Date(log.import_started_at),
      });
      return { ok: true };
    }
    if (row.state === 'STOPPING' || row.state === 'STOPPED') {
      throw new Error(`Job de import em estado terminal de erro: ${row.state}`);
    }
    // EXECUTING / DEFINING / IDLING / COMPLETING -> continua
  }
  throw new Error(`Timeout aguardando import (${IMPORT_TIMEOUT_MS}ms)`);
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

export async function runDailyBackup({ triggeredBy = 'cron' } = {}) {
  await mkdir(TMP_DIR, { recursive: true });

  const startedAt = new Date();
  const yyyymmdd  = startedAt.toISOString().slice(0, 10);
  const localGz   = path.join(TMP_DIR, `sienge-${yyyymmdd}.dmpc.gz`);
  const objectKey = `daily/sienge-${yyyymmdd}.dmpc`;

  const log = await db.SiengeBackupLog.create({
    started_at: startedAt,
    status: 'running',
    stage: 'starting',
    triggered_by: triggeredBy,
  });

  try {
    // Fase 1.1 - MD5 esperado
    await log.update({ stage: 'fetching_md5' });
    const expectedMd5 = await fetchExpectedMd5();

    // Fase 1.2 - download
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

    // Fase 1.3 - upload no bucket
    await log.update({ stage: 'uploading' });
    await uploadDecompressedToBucket(localGz, objectKey);

    await log.update({
      bucket_object: objectKey,
      stage: 'uploaded',
    });

    // Fase 1.4 - cleanup do .gz local
    await unlink(localGz).catch(() => {});

    // ─── Fase 2 - import + cleanup do bucket ───
    if (!AUTO_IMPORT_ENABLED) {
      await log.update({ import_status: 'skipped' });
    } else {
      try {
        await importIntoOracleDB(objectKey, log);
        // Só apaga backups antigos APÓS import OK
        await log.update({ stage: 'cleaning_bucket' });
        const cleaned = await deleteOtherBackupsInBucket(objectKey);
        await log.update({ cleaned_objects_count: cleaned });
      } catch (importErr) {
        const finishedAt = new Date();
        await log.update({
          import_status: 'failed',
          import_finished_at: finishedAt,
          import_duration_ms: finishedAt - new Date(log.import_started_at || startedAt),
          import_error_message: String(importErr?.message || importErr).slice(0, 4000),
        });
        // Mantém backup atual no bucket (não apaga os antigos) — assim ainda dá pra retry/debug
        throw importErr;
      }
    }

    const finishedAt = new Date();
    await log.update({
      status: 'success',
      stage: 'done',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });

    return { ok: true, logId: log.id, objectKey, size };
  } catch (err) {
    const finishedAt = new Date();
    await log.update({
      status: 'failed',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
      error_message: String(err?.message || err).slice(0, 4000),
    });
    await unlink(localGz).catch(() => {});
    throw err;
  }
}

/**
 * Roda apenas a Fase 2 (import + cleanup) sobre um objeto que já existe
 * no bucket. Útil quando o backup do dia já foi baixado/upado e você
 * só quer disparar o restore.
 *
 * Se objectKey não for passado, pega o mais recente em "daily/".
 */
export async function runImportOnly({ objectKey, triggeredBy = 'manual-import' } = {}) {
  const startedAt = new Date();
  const targetKey = objectKey || await findLatestBucketObject();

  if (!targetKey) {
    throw new Error('Nenhum objeto encontrado em daily/ no bucket');
  }

  const log = await db.SiengeBackupLog.create({
    started_at: startedAt,
    status: 'running',
    stage: 'importing',
    triggered_by: triggeredBy,
    bucket_object: targetKey,
    file_name: path.basename(targetKey),
  });

  try {
    await importIntoOracleDB(targetKey, log);

    await log.update({ stage: 'cleaning_bucket' });
    const cleaned = await deleteOtherBackupsInBucket(targetKey);
    await log.update({ cleaned_objects_count: cleaned });

    const finishedAt = new Date();
    await log.update({
      status: 'success',
      stage: 'done',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
    });

    return { ok: true, logId: log.id, objectKey: targetKey };
  } catch (err) {
    const finishedAt = new Date();
    await log.update({
      status: 'failed',
      finished_at: finishedAt,
      duration_ms: finishedAt - startedAt,
      error_message: String(err?.message || err).slice(0, 4000),
    });
    throw err;
  }
}

export default { runDailyBackup, runImportOnly };
