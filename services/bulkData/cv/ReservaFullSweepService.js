// services/bulkData/cv/ReservaFullSweepService.js
//
// VARREDURA ID-A-ID — bate em /v1/comercial/reservas/{id} para todo idreserva
// no range [1..MAX_LOCAL+MARGEM]. Garante que reservas em estado terminal
// (Cancelada/Vencida/Distrato) que a listagem global esconde sejam encontradas.
//
// COMPORTAMENTO:
//   - existing em DB → preserva histórico (status[]) e só atualiza se snapshot mudou
//   - new (200) → cria com primeiro snapshot
//   - 404 → grava em cv_reserva_id_dead (não é tentado mais nas próximas runs)
//   - 5xx/429 → retry com backoff (igual ao service principal)
//
// PARALELISMO:
//   - 16 paralelas + gap MIN_TIME_MS (default 60ms) → ~16 req/s sustentadas
//   - 6500 IDs ≈ 6 minutos
//
// LOGS:
//   - Início: total a varrer, dead pulados, configuração
//   - Durante: a cada PROGRESS_EVERY IDs processados, com ETA
//   - Final: resumo completo

import { Op } from 'sequelize';
import db from '../../../models/sequelize/index.js';
import apiCv from '../../../lib/apiCv.js';

const { Reserva, Repasse, CvReservaIdDead } = db;

// ===================== Config =====================
const SWEEP_MAX_CONCURRENT = parseInt(process.env.RESERVA_SWEEP_CONCURRENT || '16', 10);
const SWEEP_MIN_TIME_MS    = parseInt(process.env.RESERVA_SWEEP_MIN_TIME_MS || '60', 10);
const SWEEP_TAIL_MARGIN    = parseInt(process.env.RESERVA_SWEEP_TAIL_MARGIN || '100', 10);
const PROGRESS_EVERY       = parseInt(process.env.RESERVA_SWEEP_PROGRESS_EVERY || '200', 10);
const MAX_RETRIES          = parseInt(process.env.CVCRM_MAX_RETRIES || '5', 10);
const BASE_BACKOFF_MS      = parseInt(process.env.CVCRM_BASE_BACKOFF_MS || '500', 10);
const MAX_BACKOFF_MS       = parseInt(process.env.CVCRM_MAX_BACKOFF_MS || '8000', 10);
const JITTER_MS            = parseInt(process.env.CVCRM_JITTER_MS || '250', 10);

// ===================== Utils =====================
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const toDate = (s) => (s ? new Date(String(s).replace(' ', 'T')) : null);
const fmtSec = (ms) => (ms / 1000).toFixed(1) + 's';
const fmtETA = (ms) => {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
};

function buildSnapshot(core, repasseMirror = null) {
    const sit = core?.situacao || {};
    return {
        status_reserva: repasseMirror?.status_reserva ?? core?.status_reserva ?? sit?.nome ?? sit?.situacao ?? null,
        status_repasse: repasseMirror?.status_repasse ?? core?.status_repasse ?? null,
        idsituacao_repasse: repasseMirror?.idsituacao_repasse ?? core?.idsituacao_repasse ?? null,
        data_status_repasse: repasseMirror?.data_status_repasse
            ? new Date(repasseMirror.data_status_repasse).toISOString().slice(0, 19).replace('T', ' ')
            : (core?.data_status_repasse ?? null),
        captured_at: new Date().toISOString(),
    };
}

function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    return (
        (a.status_reserva ?? null) === (b.status_reserva ?? null) &&
        (a.status_repasse ?? null) === (b.status_repasse ?? null) &&
        String(a.idsituacao_repasse ?? '') === String(b.idsituacao_repasse ?? '') &&
        String(a.data_status_repasse ?? '') === String(b.data_status_repasse ?? '')
    );
}

// ===================== Rate limit paralelo + retry =====================
let _inFlight = 0;
const _slotWaiters = [];
let _gapChain = Promise.resolve();
let _lastStart = 0;

async function _acquireSlot() {
    if (_inFlight < SWEEP_MAX_CONCURRENT) { _inFlight++; return; }
    await new Promise(r => _slotWaiters.push(r));
    _inFlight++;
}
function _releaseSlot() {
    _inFlight--;
    const next = _slotWaiters.shift();
    if (next) next();
}

async function getWithRetry(path, config = {}, attempt = 1) {
    try { return await apiCv.get(path, config); }
    catch (e) {
        const status = e?.response?.status;
        // 404 e 400 retornam direto, NÃO são retry (significam "ID não existe / inválido")
        if (status === 404 || status === 400) throw e;
        if ((status === 429 || (status >= 500 && status <= 599)) && attempt <= MAX_RETRIES) {
            const retryAfterSec = parseInt(e?.response?.headers?.['retry-after'] || '0', 10);
            const backoff = retryAfterSec
                ? retryAfterSec * 1000
                : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * JITTER_MS), MAX_BACKOFF_MS);
            console.warn(`[Sweep][HTTP RETRY] ${path} status=${status} attempt=${attempt} wait=${backoff}ms`);
            await sleep(backoff);
            return getWithRetry(path, config, attempt + 1);
        }
        throw e;
    }
}

async function rateLimited(fn) {
    await _acquireSlot();
    const startSlot = _gapChain.then(async () => {
        const wait = Math.max(0, SWEEP_MIN_TIME_MS - (Date.now() - _lastStart));
        if (wait) await sleep(wait);
        _lastStart = Date.now();
    });
    _gapChain = startSlot.catch(() => { });
    await startSlot;
    try { return await fn(); }
    finally { _releaseSlot(); }
}

const httpGet = (path, config) => rateLimited(() => getWithRetry(path, config));

// ===================== Fetchers =====================
async function fetchReservaCore(idreserva) {
    const { data } = await httpGet(`/v1/comercial/reservas/${idreserva}`);
    return data?.[String(idreserva)] || null;
}
async function fetchReservaDocumentos(idreserva) {
    const { data } = await httpGet(`/v1/comercial/reservas/${idreserva}/documentos`);
    return data ?? {};
}
async function fetchReservaErpSienge(idreserva) {
    const { data } = await httpGet(`/v1/comercial/reservas/${idreserva}/erp/sienge`);
    return data ?? {};
}
async function fetchReservaCampanhas(idreserva) {
    const { data } = await httpGet(`/v1/comercial/reservas/${idreserva}/campanhas`);
    return Array.isArray(data) ? data : [];
}
async function fetchReservaMensagensAll(idreserva) {
    const all = [];
    let pagina = 1;
    while (true) {
        const { data } = await httpGet(`/v1/comercial/reservas/${idreserva}/mensagens`, { params: { pagina } });
        const dados = data?.dados ?? [];
        all.push(...dados);
        const totalPag = data?.paginacao?.total_de_paginas || 1;
        if (pagina >= totalPag) break;
        pagina += 1;
    }
    return all;
}

// ===================== Map =====================
function mapReservaToCols(idreserva, core, docs, erp, campanhas, mensagens, snap) {
    const unidade = core?.unidade || {};
    const titular = core?.titular || {};
    return {
        idreserva,
        status_reserva: snap.status_reserva ?? null,
        status_repasse: snap.status_repasse ?? null,
        idsituacao_repasse: snap.idsituacao_repasse ?? null,
        data_status_repasse: snap.data_status_repasse ? toDate(snap.data_status_repasse) : null,
        documento: titular?.documento ?? null,
        empreendimento: unidade?.empreendimento ?? null,
        etapa: unidade?.etapa ?? null,
        bloco: unidade?.bloco ?? null,
        unidade: unidade?.unidade ?? null,
        situacao: core?.situacao ?? null,
        imobiliaria: core?.imobiliaria ?? null,
        unidade_json: core?.unidade ?? null,
        titular: core?.titular ?? null,
        corretor: core?.corretor ?? null,
        condicoes: core?.condicoes ?? null,
        leads_associados: core?.leads_associados ?? null,
        idproposta_cv: core?.idproposta_cv ?? null,
        idproposta_int: core?.idproposta_int ?? null,
        vendida: core?.vendida ?? null,
        observacoes: core?.observacoes ?? null,
        data_reserva: toDate(core?.data),
        data_contrato: toDate(core?.data_contrato),
        data_venda: toDate(core?.data_venda),
        idtipovenda: core?.idtipovenda ?? null,
        tipovenda: core?.tipovenda ?? null,
        idprecadastro: core?.idprecadastro ?? null,
        ultima_mensagem: core?.ultima_mensagem ?? null,
        idtime: core?.idtime ?? null,
        contratos: core?.contratos ?? null,
        empresa_correspondente: core?.empresaCorrespondente ?? null,
        documentos: docs ?? {},
        erp_sienge: erp ?? {},
        campanhas: campanhas ?? [],
        mensagens: mensagens ?? [],
    };
}

// ===================== Service =====================
export default class ReservaFullSweepService {
    /**
     * Varredura ID-a-ID.
     * @param {object} opts
     * @param {number}    [opts.fromId]  - id inicial (default: 1)
     * @param {number}    [opts.toId]    - id final (default: max(idreserva) + SWEEP_TAIL_MARGIN)
     * @param {boolean}   [opts.skipDead]- se true (default), pula IDs já marcados como 404
     * @param {number[]}  [opts.ids]     - se fornecido, ignora fromId/toId e processa SOMENTE estes IDs
     */
    async run(opts = {}) {
        const t0 = Date.now();

        // ---- 1) Pré-carregamento ----
        // maxLocal = MAIOR id já conhecido no sistema (vivo OU morto).
        // Usar GREATEST entre as duas tabelas evita "regressão" se um ID alto
        // for marcado como morto e nunca entrar em `reservas`.
        // Garante que o range cresce monotonicamente conforme o CV aloca novos IDs.
        const [maxRow] = await db.sequelize.query(
            `SELECT GREATEST(
                COALESCE((SELECT MAX(idreserva) FROM reservas), 0),
                COALESCE((SELECT MAX(idreserva) FROM cv_reserva_id_dead), 0)
             ) AS max_id`,
            { type: db.Sequelize.QueryTypes.SELECT }
        );
        const maxLocal = Number(maxRow?.max_id || 0);

        const explicitIds = Array.isArray(opts.ids) ? opts.ids.map(Number).filter(Number.isFinite) : null;
        const fromId   = explicitIds ? null : Math.max(1, parseInt(opts.fromId || 1, 10));
        const toId     = explicitIds ? null : Math.max(fromId, parseInt(opts.toId || (maxLocal + SWEEP_TAIL_MARGIN), 10));
        const skipDead = opts.skipDead !== false;

        // Snapshots existentes (último snapshot por reserva) — para detectar mudança
        const allRows = await Reserva.findAll({
            attributes: ['idreserva', 'status'],
            raw: true,
        });
        const existingSnap = new Map();
        for (const r of allRows) existingSnap.set(r.idreserva, r.status?.[0] || null);

        // Repasses (espelham status do CRM Repasse) — usados como mirror do snapshot
        const repasses = await Repasse.findAll({
            attributes: ['idreserva', 'status_reserva', 'status_repasse', 'idsituacao_repasse', 'data_status_repasse'],
            where: { idreserva: { [Op.ne]: null } },
            raw: true,
        });
        const repasseMap = new Map();
        for (const r of repasses) if (r.idreserva && !repasseMap.has(r.idreserva)) repasseMap.set(r.idreserva, r);

        // IDs mortos (já 404 antes) — pula
        const deadRows = await CvReservaIdDead.findAll({ attributes: ['idreserva'], raw: true });
        const deadSet = new Set(deadRows.map(r => r.idreserva));

        // Monta lista final de IDs
        const idsToScan = [];
        if (explicitIds) {
            // Modo retry: lista explícita de IDs (pula dead se solicitado)
            for (const id of explicitIds) {
                if (skipDead && deadSet.has(id)) continue;
                idsToScan.push(id);
            }
        } else {
            for (let id = fromId; id <= toId; id++) {
                if (skipDead && deadSet.has(id)) continue;
                idsToScan.push(id);
            }
        }

        const totalScan = idsToScan.length;
        console.log(`\n🚀 [Sweep] VARREDURA ID-A-ID iniciada`);
        if (explicitIds) {
            console.log(`   modo             : RETRY (lista explícita)`);
            console.log(`   ids fornecidos   : ${explicitIds.length}`);
        } else {
            console.log(`   range            : ${fromId}..${toId}`);
        }
        console.log(`   max idreserva DB : ${maxLocal}`);
        console.log(`   já no DB         : ${existingSnap.size}`);
        console.log(`   já marcados 404  : ${deadSet.size} ${skipDead ? '(pulados)' : '(REVISITADOS)'}`);
        console.log(`   total a varrer   : ${totalScan}`);
        console.log(`   concurrency      : ${SWEEP_MAX_CONCURRENT} | gap=${SWEEP_MIN_TIME_MS}ms`);
        console.log(`   ETA estimado     : ${fmtETA((totalScan / SWEEP_MAX_CONCURRENT) * SWEEP_MIN_TIME_MS + totalScan * 200)}\n`);

        // ---- 2) Contadores ----
        let processed = 0;
        let created   = 0;
        let updated   = 0;
        let unchanged = 0;
        let notFound  = 0;
        let failed    = 0;
        let lastLog   = Date.now();
        const failedIds = [];                 // ids que falharam (não-404)
        const failureByStatus = new Map();    // ex.: 500 -> 812, 'timeout' -> 283
        const bumpFailure = (key) => failureByStatus.set(key, (failureByStatus.get(key) || 0) + 1);

        const reportProgress = (force = false) => {
            if (!force && processed % PROGRESS_EVERY !== 0) return;
            const elapsed = Date.now() - t0;
            const rate = processed / (elapsed / 1000);
            const remaining = totalScan - processed;
            const etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
            const pct = ((processed / totalScan) * 100).toFixed(1);
            console.log(
                `   → ${processed}/${totalScan} (${pct}%) | ` +
                `criados=${created} atualizados=${updated} mantidos=${unchanged} ` +
                `404=${notFound} falhas=${failed} | ` +
                `${rate.toFixed(1)} req/s | ETA ${fmtETA(etaMs)} | elapsed ${fmtETA(elapsed)}`
            );
            lastLog = Date.now();
        };

        // ---- 3) Processador por ID (preserva histórico) ----
        const processOne = async (idreserva) => {
            const isNew = !existingSnap.has(idreserva);
            const repasseMirror = repasseMap.get(idreserva) || null;

            try {
                const core = await fetchReservaCore(idreserva);
                if (!core) {
                    // Resposta 200 mas vazia → trata como 404 leve
                    await CvReservaIdDead.upsert({
                        idreserva,
                        last_status: 204,
                        attempts: 1,
                        first_seen_at: new Date(),
                        last_check_at: new Date(),
                        message: 'Resposta 200 sem core'
                    });
                    notFound++;
                    return;
                }

                const snap = buildSnapshot(core, repasseMirror);
                const prevSnap = existingSnap.get(idreserva) || null;

                // Sem mudança → só atualiza last_seen_at
                if (!isNew && snapshotsEqual(prevSnap, snap)) {
                    await Reserva.update(
                        { last_seen_at: new Date() },
                        { where: { idreserva } }
                    );
                    unchanged++;
                    return;
                }

                // Mudou OU é novo → busca complementos e upsert
                const docs      = await fetchReservaDocumentos(idreserva);
                const erp       = await fetchReservaErpSienge(idreserva);
                const campanhas = await fetchReservaCampanhas(idreserva);
                const mensagens = await fetchReservaMensagensAll(idreserva);
                const mapped = mapReservaToCols(idreserva, core, docs, erp, campanhas, mensagens, snap);
                const now = new Date();

                if (isNew) {
                    await Reserva.create({
                        ...mapped,
                        status: [snap],            // primeiro snapshot do histórico
                        first_seen_at: now,
                        last_seen_at: now,
                    });
                    created++;
                } else {
                    // Preserva histórico: prepend novo snapshot na frente do array
                    const existingFull = await Reserva.findByPk(idreserva, { attributes: ['status'] });
                    const nextStatus = [snap, ...((existingFull?.status) || [])];
                    await Reserva.update(
                        { ...mapped, status: nextStatus, last_seen_at: now },
                        { where: { idreserva } }
                    );
                    updated++;
                }
                existingSnap.set(idreserva, snap);
            } catch (e) {
                const status = e?.response?.status;
                // 404 ou 400 → ID inexistente no CV.
                // O CV usa 400 para reservas excluídas/expurgadas/IDs nunca alocados como registro real.
                // Tratamos como "morto" e nunca mais tentamos.
                if (status === 404 || status === 400) {
                    const bodyMsg = e?.response?.data
                        ? (typeof e.response.data === 'string'
                            ? e.response.data.slice(0, 200)
                            : JSON.stringify(e.response.data).slice(0, 200))
                        : null;
                    await CvReservaIdDead.upsert({
                        idreserva,
                        last_status: status,
                        attempts: 1,
                        first_seen_at: new Date(),
                        last_check_at: new Date(),
                        message: bodyMsg,
                    });
                    notFound++;
                } else {
                    failed++;
                    failedIds.push(idreserva);
                    // Categoriza falha por status HTTP ou tipo de erro
                    const key = status
                        ? String(status)
                        : (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '') ? 'timeout' : (e?.code || 'unknown'));
                    bumpFailure(key);
                    // Log mais limpo: só primeiras 20 falhas pra não inundar
                    if (failed <= 20) {
                        console.error(`[Sweep] Falha id=${idreserva} key=${key} msg=${e?.message}`);
                    }
                }
            }
        };

        // ---- 4) Workers paralelos ----
        let cursor = 0;
        const worker = async () => {
            while (true) {
                const idx = cursor++;
                if (idx >= idsToScan.length) break;
                await processOne(idsToScan[idx]);
                processed++;
                reportProgress();
            }
        };

        const workers = Array.from({ length: SWEEP_MAX_CONCURRENT }, () => worker());
        await Promise.all(workers);
        reportProgress(true);

        // ---- 5) Resumo final ----
        const took_s = ((Date.now() - t0) / 1000).toFixed(1);
        const failureBreakdown = Object.fromEntries(
            [...failureByStatus.entries()].sort((a, b) => b[1] - a[1])
        );
        const stats = {
            range: explicitIds ? { ids_count: explicitIds.length } : { from: fromId, to: toId },
            total_scanned: processed,
            created,
            updated,
            unchanged,
            not_found: notFound,
            failed,
            failure_by_status: failureBreakdown,
            failed_ids: failedIds, // útil pra retry direcionado
            took_s,
        };

        console.log(`\n🎉 [Sweep] CONCLUÍDO em ${took_s}s`);
        if (explicitIds) {
            console.log(`   modo           : RETRY (${explicitIds.length} ids)`);
        } else {
            console.log(`   range          : ${fromId}..${toId}`);
        }
        console.log(`   varridos       : ${processed}`);
        console.log(`   criados (NOVOS): ${created}   ← reservas que não tínhamos`);
        console.log(`   atualizados    : ${updated}   ← snapshot mudou (histórico preservado)`);
        console.log(`   mantidos       : ${unchanged} ← inalterados`);
        console.log(`   404 (mortos)   : ${notFound}  ← gravados em cv_reserva_id_dead`);
        console.log(`   falhas         : ${failed}`);
        if (failed > 0) {
            console.log(`   falhas por tipo:`);
            for (const [k, v] of Object.entries(failureBreakdown)) {
                console.log(`     ${k.padEnd(10)} → ${v}`);
            }
            console.log(`   → para retry destes ids: POST /api/cv/reservas/sync/full-sweep com body { "ids": [...] }`);
        }
        console.log('');

        return stats;
    }
}
