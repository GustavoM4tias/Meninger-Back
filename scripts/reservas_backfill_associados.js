// scripts/reservas_backfill_associados.js
//
// Backfill da coluna `associados` (co-compradores/cônjuge) nas reservas antigas.
// O sync e o full sweep só regravam a reserva quando o snapshot muda, então
// reservas estáveis ficariam com associados = NULL para sempre. Este script
// varre as reservas com associados IS NULL, busca SÓ o core no CV
// (1 request/reserva, sem docs/ERP/campanhas/mensagens) e grava só a coluna nova.
//
// Idempotente: quem já foi processado recebe [] (mesmo sem associado) e sai do
// filtro IS NULL, então dá para reexecutar após interrupção sem repetir trabalho.
//
// Uso:
//   node scripts/reservas_backfill_associados.js               (todas pendentes)
//   node scripts/reservas_backfill_associados.js --limit=100   (no máx. N)

import db from '../models/sequelize/index.js';
import apiCv from '../lib/apiCv.js';

const { Reserva } = db;

const MAX_CONCURRENT  = parseInt(process.env.RESERVA_SWEEP_CONCURRENT || '8', 10);
const MIN_TIME_MS     = parseInt(process.env.RESERVA_SWEEP_MIN_TIME_MS || '80', 10);
const MAX_RETRIES     = parseInt(process.env.CVCRM_MAX_RETRIES || '5', 10);
const BASE_BACKOFF_MS = parseInt(process.env.CVCRM_BASE_BACKOFF_MS || '500', 10);
const MAX_BACKOFF_MS  = parseInt(process.env.CVCRM_MAX_BACKOFF_MS || '8000', 10);
const PROGRESS_EVERY  = 100;

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function arg(name, def = null) {
    const hit = process.argv.find(a => a.startsWith(`--${name}`));
    if (!hit) return def;
    const [, val] = hit.split('=');
    return val === undefined ? true : val;
}

async function getWithRetry(path, attempt = 1) {
    try { return await apiCv.get(path); }
    catch (e) {
        const status = e?.response?.status;
        if (status === 404 || status === 400) throw e; // ID morto, sem retry
        if ((status === 429 || (status >= 500 && status <= 599)) && attempt <= MAX_RETRIES) {
            const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
            console.warn(`   [retry] ${path} status=${status} attempt=${attempt} wait=${backoff}ms`);
            await sleep(backoff);
            return getWithRetry(path, attempt + 1);
        }
        throw e;
    }
}

async function processWithLimit(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.max(1, limit) }, () => (async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) break;
            await fn(items[idx], idx);
            await sleep(MIN_TIME_MS);
        }
    })());
    await Promise.all(workers);
}

async function main() {
    const limit = Number(arg('limit', 0)) || 0;

    // Garante a coluna mesmo sem o backend ter reiniciado com o novo model
    console.log('🔧 Garantindo coluna reservas.associados…');
    await db.sequelize.query('ALTER TABLE reservas ADD COLUMN IF NOT EXISTS associados JSONB;');

    const pending = await Reserva.findAll({
        where: { associados: null },
        attributes: ['idreserva'],
        order: [['idreserva', 'ASC']],
        raw: true,
        ...(limit ? { limit } : {}),
    });

    console.log(`🔎 ${pending.length} reserva(s) pendente(s). Concurrency=${MAX_CONCURRENT}, gap=${MIN_TIME_MS}ms\n`);

    const t0 = Date.now();
    let done = 0, filled = 0, empty = 0, failed = 0;

    await processWithLimit(pending, MAX_CONCURRENT, async ({ idreserva }) => {
        try {
            const { data } = await getWithRetry(`/v1/comercial/reservas/${idreserva}`);
            const core = data?.[String(idreserva)] || null;
            const associados = Array.isArray(core?.associados_array) ? core.associados_array : [];
            await Reserva.update({ associados }, { where: { idreserva } });
            associados.length ? filled++ : empty++;
        } catch (e) {
            failed++;
            console.warn(`   ⚠️  #${idreserva}: ${e?.response?.status || e?.message}`);
        } finally {
            done++;
            if (done % PROGRESS_EVERY === 0) {
                const rate = done / ((Date.now() - t0) / 1000);
                const eta = Math.round((pending.length - done) / rate);
                console.log(`   → ${done}/${pending.length} | com associados=${filled} vazias=${empty} falhas=${failed} | ${rate.toFixed(1)} req/s | ETA ~${eta}s`);
            }
        }
    });

    console.log(`\n✨ Concluído em ${Math.round((Date.now() - t0) / 1000)}s: ${filled} com associados, ${empty} sem, ${failed} falha(s).`);
    process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('Erro fatal:', err); process.exit(1); });
