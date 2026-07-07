// lib/schemaSyncGate.js
//
// Pula a fase de sync/patches de schema no boot quando NADA mudou desde o
// último boot bem-sucedido.
//
// O projeto evolui o schema via sync({alter}) + patches ensure* no boot (não
// usa migrations CLI). Isso custa centenas de round-trips no Postgres remoto
// a CADA start, mesmo sem mudança nenhuma. Este gate tira um fingerprint dos
// arquivos que definem schema/seed (models/, lib/ensure*.js e seeds de boot)
// e compara com o do último sync completo, guardado no próprio banco:
//   - igual     → boot rápido: pula sync global, alters por model e patches;
//   - diferente → roda a fase completa e grava o fingerprint novo no final.
//
// Escape hatches por env:
//   FORCE_DB_SYNC=true → sempre roda a fase completa (ex.: schema mexido à mão)
//   SKIP_DB_SYNC=true  → sempre pula (emergência)
//
// Local e produção compartilham o mesmo banco: se rodarem códigos diferentes,
// cada troca de lado re-roda a fase completa (o fingerprint alterna). O pior
// caso é exatamente o comportamento antigo.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Bump manual quando algo que muda schema viver fora dos arquivos hasheados.
const SCHEMA_REV = 'v1';

// Seeds que rodam no boot mas moram fora de models//lib — mudar neles também
// precisa re-liberar a fase completa.
const EXTRA_FILES = [
    'controllers/sienge/launchTypeController.js', // seedInitialTypes
    'services/emeAtende/emeAtendeSeed.js',        // ensureEmeAtendeSeed
    'services/checklist/seedChecklist.js',        // seedChecklist
];

function* walkJs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkJs(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) yield full;
    }
}

export function computeSchemaFingerprint() {
    const files = [...walkJs(path.join(ROOT, 'models'))];
    for (const entry of fs.readdirSync(path.join(ROOT, 'lib'))) {
        if (/^ensure.*\.js$/.test(entry)) files.push(path.join(ROOT, 'lib', entry));
    }
    for (const rel of EXTRA_FILES) {
        const full = path.join(ROOT, rel);
        if (fs.existsSync(full)) files.push(full);
    }
    files.sort();

    const hash = crypto.createHash('sha256');
    hash.update(SCHEMA_REV);
    for (const f of files) {
        hash.update(path.relative(ROOT, f).replaceAll('\\', '/'));
        hash.update(fs.readFileSync(f));
    }
    return hash.digest('hex');
}

async function ensureStateTable(sequelize) {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS boot_schema_state (
            id          SMALLINT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
}

/**
 * Decide se a fase de schema precisa rodar neste boot.
 * @returns {{ run: boolean, fingerprint: string|null, reason: string }}
 */
export async function shouldRunSchemaSync(sequelize) {
    if (process.env.SKIP_DB_SYNC === 'true') {
        return { run: false, fingerprint: null, reason: 'SKIP_DB_SYNC=true' };
    }

    let fingerprint = null;
    try {
        fingerprint = computeSchemaFingerprint();
    } catch (e) {
        // Sem fingerprint não dá pra provar que nada mudou — roda completo.
        return { run: true, fingerprint: null, reason: `fingerprint falhou: ${e.message}` };
    }

    if (process.env.FORCE_DB_SYNC === 'true') {
        return { run: true, fingerprint, reason: 'FORCE_DB_SYNC=true' };
    }

    try {
        await ensureStateTable(sequelize);
        const [rows] = await sequelize.query(
            'SELECT fingerprint FROM boot_schema_state WHERE id = 1');
        const stored = rows?.[0]?.fingerprint || null;
        if (stored === fingerprint) {
            return { run: false, fingerprint, reason: 'schema inalterado desde o último boot' };
        }
        return { run: true, fingerprint, reason: stored ? 'schema mudou' : 'primeiro boot com o gate' };
    } catch (e) {
        return { run: true, fingerprint, reason: `leitura do estado falhou: ${e.message}` };
    }
}

/** Grava o fingerprint após uma fase de schema COMPLETA e bem-sucedida. */
export async function recordSchemaSync(sequelize, fingerprint) {
    if (!fingerprint) return;
    try {
        await ensureStateTable(sequelize);
        await sequelize.query(
            `INSERT INTO boot_schema_state (id, fingerprint, synced_at)
             VALUES (1, :fingerprint, NOW())
             ON CONFLICT (id) DO UPDATE
                SET fingerprint = EXCLUDED.fingerprint, synced_at = NOW()`,
            { replacements: { fingerprint } });
    } catch (e) {
        // Não gravar só significa que o próximo boot roda a fase completa.
        console.warn('⚠️  [SchemaGate] falha ao gravar fingerprint:', e.message);
    }
}

export default { computeSchemaFingerprint, shouldRunSchemaSync, recordSchemaSync };
