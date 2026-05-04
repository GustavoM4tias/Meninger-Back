// services/bulkData/cv/ReservaSyncService.js
//
// Sync de reservas — versão simples e rápida.
//
// DISCOVERY (cobre 100% das reservas no CV):
//   1) listar global [situacao=todas + retornar_integradas=true] — pega ~tudo
//      EXCETO Cancelada/Vencida/Distrato (a API omite esses status no modo global)
//   2) listar por idsituacao (em paralelo) — pega Cancelada/Vencida/Distrato
//      usando os idsituacao distintos já conhecidos no banco local
//   3) fallback Repasse local — pega o que CV omitir totalmente
//
// PROCESSAMENTO:
//   - hash check via snapshot (status_reserva + status_repasse + idsituacao_repasse + data_status_repasse)
//   - se igual → bulk UPDATE last_seen_at (1 SQL pelo chunk inteiro)
//   - se diferente → fetch core/docs/erp/campanhas/mensagens, upsert
//
// PARALELISMO:
//   - rate limiter paralelo (MAX_CONCURRENT=8, MIN_TIME_MS=80) → ~12 req/s
//   - listar global e listar por situacao rodam todos em paralelo

import { Op } from 'sequelize';
import db from '../../../models/sequelize/index.js';
import apiCv from '../../../lib/apiCv.js';

const { Reserva, Repasse } = db;

// ===================== Config =====================
const LIST_LIMIT          = parseInt(process.env.RESERVA_LIST_LIMIT || '500', 10);
const RESERVA_CHUNK       = parseInt(process.env.RESERVA_UPSERT_CHUNK || '100', 10);
const RESERVA_CONCURRENCY = parseInt(process.env.RESERVA_CONCURRENCY || '6', 10);
const MAX_CONCURRENT      = parseInt(process.env.RESERVA_MAX_CONCURRENT || '8', 10);
const MIN_TIME_MS         = parseInt(process.env.RESERVA_MIN_TIME_MS || '80', 10);
const MAX_RETRIES         = parseInt(process.env.CVCRM_MAX_RETRIES || '5', 10);
const BASE_BACKOFF_MS     = parseInt(process.env.CVCRM_BASE_BACKOFF_MS || '500', 10);
const MAX_BACKOFF_MS      = parseInt(process.env.CVCRM_MAX_BACKOFF_MS || '8000', 10);
const JITTER_MS           = parseInt(process.env.CVCRM_JITTER_MS || '250', 10);

// ===================== Utils =====================
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const toDate = (s) => (s ? new Date(String(s).replace(' ', 'T')) : null);

function buildSnapshot(entry, repasseMirror = null) {
    const sit = entry?.situacao || {};
    return {
        status_reserva: repasseMirror?.status_reserva ?? entry?.status_reserva ?? sit?.nome ?? sit?.situacao ?? null,
        status_repasse: repasseMirror?.status_repasse ?? entry?.status_repasse ?? null,
        idsituacao_repasse: repasseMirror?.idsituacao_repasse ?? entry?.idsituacao_repasse ?? null,
        data_status_repasse: repasseMirror?.data_status_repasse
            ? new Date(repasseMirror.data_status_repasse).toISOString().slice(0, 19).replace('T', ' ')
            : (entry?.data_status_repasse ?? null),
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
// MAX_CONCURRENT requisições em voo + MIN_TIME_MS de gap entre starts.
// Ex.: 8 concurrent + 80ms gap → ~12 starts/s sustentadas.
let _inFlight = 0;
const _slotWaiters = [];
let _gapChain = Promise.resolve();
let _lastStart = 0;

async function _acquireSlot() {
    if (_inFlight < MAX_CONCURRENT) { _inFlight++; return; }
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
        if ((status === 429 || (status >= 500 && status <= 599)) && attempt <= MAX_RETRIES) {
            const retryAfterSec = parseInt(e?.response?.headers?.['retry-after'] || '0', 10);
            const backoff = retryAfterSec
                ? retryAfterSec * 1000
                : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * JITTER_MS), MAX_BACKOFF_MS);
            console.warn(`[Reservas][HTTP RETRY] ${path} status=${status} attempt=${attempt} wait=${backoff}ms`);
            await sleep(backoff);
            return getWithRetry(path, config, attempt + 1);
        }
        throw e;
    }
}

async function rateLimited(fn) {
    await _acquireSlot();
    const startSlot = _gapChain.then(async () => {
        const wait = Math.max(0, MIN_TIME_MS - (Date.now() - _lastStart));
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

/** Faz uma página do listar com os params dados; injeta idreserva da chave do objeto. */
async function fetchReservaListarPage(params) {
    const { data, status } = await httpGet('/v1/comercial/reservas', { params });
    if (status === 204 || !data || typeof data !== 'object') return [];
    const out = [];
    for (const [k, v] of Object.entries(data)) {
        const id = Number(k);
        if (!isNaN(id) && v && typeof v === 'object') out.push({ idreserva: id, ...v });
    }
    return out;
}

/** Listar paginado completo com qualquer combinação de params. */
async function fetchReservaListarAll(extraParams, label) {
    const all = [];
    let pagina = 1;
    while (true) {
        const items = await fetchReservaListarPage({
            registros_por_pagina: LIST_LIMIT,
            pagina,
            ...extraParams,
        });
        all.push(...items);
        if (label) console.log(`   → [${label}] pág ${pagina}: ${items.length} (acumulado=${all.length})`);
        if (items.length < LIST_LIMIT) break;
        pagina += 1;
    }
    return all;
}

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

// ===================== Concurrency helper =====================
async function processWithLimit(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.max(1, limit) }, () => (async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) break;
            await fn(items[idx], idx);
        }
    })());
    await Promise.all(workers);
}

// ===================== Service =====================
export default class ReservaSyncService {
    async loadAll()   { console.log('🚀 [Reservas] Carga inicial');   return this._run(); }
    async loadDelta() { console.log('🚀 [Reservas] Delta');           return this._run(); }

    async _run() {
        const t0 = Date.now();
        let total = 0, created = 0, updated = 0, unchanged = 0, failed = 0;

        // 1) Pré-carrega: snapshots existentes + Repasses + situações conhecidas
        const allRows = await Reserva.findAll({
            attributes: ['idreserva', 'status'],
            raw: true,
        });
        const existingSnap = new Map();
        for (const r of allRows) existingSnap.set(r.idreserva, r.status?.[0] || null);

        const repasses = await Repasse.findAll({
            attributes: ['idreserva', 'status_reserva', 'status_repasse', 'idsituacao_repasse', 'data_status_repasse'],
            where: { idreserva: { [Op.ne]: null } },
            raw: true,
        });
        const repasseMap = new Map();
        for (const r of repasses) if (r.idreserva && !repasseMap.has(r.idreserva)) repasseMap.set(r.idreserva, r);

        const sitRows = await db.sequelize.query(`
            SELECT DISTINCT (situacao->>'idsituacao')::int AS idsit, situacao->>'situacao' AS nome
            FROM reservas
            WHERE situacao IS NOT NULL
              AND situacao->>'idsituacao' ~ '^[0-9]+$'
        `, { type: db.Sequelize.QueryTypes.SELECT });
        const idsituacoes = sitRows.map(r => r.idsit).filter(Number.isFinite);

        console.log(`📦 [Reservas] snapshots=${existingSnap.size} | repasses=${repasseMap.size} | situacoes=${idsituacoes.length}`);

        // 2) Discovery em PARALELO: listar global + listar por cada idsituacao
        console.log(`🔍 [Reservas] discovery em paralelo...`);
        const discoveryPromises = [
            fetchReservaListarAll({ situacao: 'todas', retornar_integradas: true }, 'global'),
            ...idsituacoes.map(idsit =>
                fetchReservaListarAll({ situacao: idsit, retornar_integradas: true }).then(items => {
                    if (items.length) console.log(`   → sit ${idsit}: ${items.length}`);
                    return items;
                })
            ),
        ];
        const discoveryResults = await Promise.all(discoveryPromises);

        const dedup = new Map();
        for (const arr of discoveryResults) {
            for (const r of arr) {
                if (r?.idreserva && !dedup.has(r.idreserva)) dedup.set(r.idreserva, r);
            }
        }
        const fromApi = dedup.size;

        // 3) Fallback: Repasses locais que a API CV omitiu por completo
        let fromRepasseOnly = 0;
        for (const [idreserva, rep] of repasseMap.entries()) {
            if (dedup.has(idreserva)) continue;
            dedup.set(idreserva, {
                idreserva,
                status_reserva: rep.status_reserva,
                status_repasse: rep.status_repasse,
                idsituacao_repasse: rep.idsituacao_repasse,
                data_status_repasse: rep.data_status_repasse,
                _from_repasse: true,
            });
            fromRepasseOnly++;
        }

        const list = Array.from(dedup.values());
        const elapsedDiscovery = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`📋 [Reservas] discovery final: ${list.length} (api=${fromApi} + repasse-only=${fromRepasseOnly}) em ${elapsedDiscovery}s`);

        // 4) Processa em chunks
        for (let i = 0; i < list.length; i += RESERVA_CHUNK) {
            const slice = list.slice(i, i + RESERVA_CHUNK);

            // 4a) Categoriza chunk em memória
            const unchangedIds = [];
            const toProcess = [];
            for (const entry of slice) {
                const idreserva = entry?.idreserva;
                if (!idreserva) { failed++; continue; }
                total++;
                const repasseMirror = repasseMap.get(idreserva) || null;
                const snap = buildSnapshot(entry, repasseMirror);
                const prevSnap = existingSnap.get(idreserva) || null;
                const isNew = !existingSnap.has(idreserva);
                if (!isNew && snapshotsEqual(prevSnap, snap)) {
                    unchangedIds.push(idreserva);
                } else {
                    toProcess.push({ entry, idreserva, snap, isNew });
                }
            }

            // 4b) BULK UPDATE last_seen_at p/ inalterados (1 SQL)
            if (unchangedIds.length) {
                await Reserva.update(
                    { last_seen_at: new Date() },
                    { where: { idreserva: unchangedIds } }
                );
                unchanged += unchangedIds.length;
            }

            // 4c) Processa novos/mudados em paralelo
            await processWithLimit(toProcess, RESERVA_CONCURRENCY, async ({ entry, idreserva, snap, isNew }) => {
                try {
                    const core = await fetchReservaCore(idreserva);
                    if (!core) { failed++; return; }
                    const docs      = await fetchReservaDocumentos(idreserva);
                    const erp       = await fetchReservaErpSienge(idreserva);
                    const campanhas = await fetchReservaCampanhas(idreserva);
                    const mensagens = await fetchReservaMensagensAll(idreserva);
                    const mapped = mapReservaToCols(idreserva, core, docs, erp, campanhas, mensagens, snap);
                    const now = new Date();
                    if (isNew) {
                        await Reserva.create({
                            ...mapped,
                            status: [snap],
                            first_seen_at: now,
                            last_seen_at: now,
                        });
                        created++;
                    } else {
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
                    failed++;
                    console.error(`[Reservas] Falha idreserva=${idreserva}:`, e?.response?.status, e?.message);
                }
            });

            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`   → ${Math.min(i + RESERVA_CHUNK, list.length)}/${list.length} | criados=${created} | atualizados=${updated} | mantidos=${unchanged} | falhas=${failed} | ${elapsed}s`);
        }

        const stats = { total, created, updated, unchanged, failed, took_s: ((Date.now() - t0) / 1000).toFixed(1) };
        console.log(`🎉 [Reservas] concluído em ${stats.took_s}s — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        return stats;
    }
}
