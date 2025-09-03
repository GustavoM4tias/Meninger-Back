import { Op } from 'sequelize';
import db from '../../../models/sequelize/index.js';
import apiCv from '../../../lib/apiCv.js';

const { Reserva, Repasse } = db;

// ===================== Config =====================
const RESERVA_CHUNK = parseInt(process.env.RESERVA_UPSERT_CHUNK || '50', 10);
// FULL: use 1–2 | DELTA: 2–3 (ajuste no .env)
const RESERVA_CONCURRENCY = parseInt(process.env.RESERVA_CONCURRENCY || '1', 10);
// minTime global entre requests à API (serializa as chamadas)
const CVCRM_MIN_TIME_MS = parseInt(process.env.CVCRM_MIN_TIME_MS || '150', 10);
// backoff
const MAX_RETRIES = parseInt(process.env.CVCRM_MAX_RETRIES || '5', 10);
const BASE_BACKOFF_MS = parseInt(process.env.CVCRM_BASE_BACKOFF_MS || '500', 10);
const MAX_BACKOFF_MS = parseInt(process.env.CVCRM_MAX_BACKOFF_MS || '8000', 10);
const JITTER_MS = parseInt(process.env.CVCRM_JITTER_MS || '250', 10);

// DELTA: janela padrão se não houver since
const DEFAULT_LOOKBACK_MIN = parseInt(process.env.RESERVA_DELTA_LOOKBACK_MIN || '40', 10);

// ===================== Utils =====================
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const toDate = (s) => (s ? new Date(String(s).replace(' ', 'T')) : null);

function buildSnapshotFromRepasse(rep) {
    return {
        status_reserva: rep.status_reserva ?? null,
        status_repasse: rep.status_repasse ?? null,
        idsituacao_repasse: rep.idsituacao_repasse ?? null,
        data_status_repasse: rep.data_status_repasse
            ? new Date(rep.data_status_repasse).toISOString().slice(0, 19).replace('T', ' ')
            : null,
        captured_at: new Date().toISOString()
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

// ===================== Rate limit + retry =====================
// Serializa TODAS as chamadas com um intervalo mínimo global (minTime)
let _rlQueue = Promise.resolve();
let _lastTs = 0;

async function getWithRetry(path, config = {}, attempt = 1) {
    try {
        return await apiCv.get(path, config);
    } catch (e) {
        const status = e?.response?.status;
        if ((status === 429 || (status >= 500 && status <= 599)) && attempt <= MAX_RETRIES) {
            const retryAfterSec = parseInt(e?.response?.headers?.['retry-after'] || '0', 10);
            const backoff = retryAfterSec
                ? retryAfterSec * 1000
                : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * JITTER_MS), MAX_BACKOFF_MS);

            console.warn(`[HTTP RETRY] ${path} status=${status} attempt=${attempt} wait=${backoff}ms`);
            await sleep(backoff);
            return getWithRetry(path, config, attempt + 1);
        }
        throw e;
    }
}

function rateLimited(fn) {
    const run = async () => {
        const now = Date.now();
        const delta = now - _lastTs;
        const wait = Math.max(0, CVCRM_MIN_TIME_MS - delta);
        if (wait) await sleep(wait);
        _lastTs = Date.now();
        return fn();
    };
    const p = _rlQueue.then(run, run);
    _rlQueue = p.catch(() => { }); // mantém a cadeia viva mesmo com erro
    return p;
}

function httpGet(path, config) {
    return rateLimited(() => getWithRetry(path, config));
}

// ===================== Fetchers (usam httpGet) =====================
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
function mapReservaToCols(idreserva, core, docs, erp, campanhas, mensagens, repasseMirror) {
    const unidade = core?.unidade || {};
    const titular = core?.titular || {};

    return {
        idreserva,

        // Espelho do status (do repasse)
        status_reserva: repasseMirror.status_reserva ?? null,
        status_repasse: repasseMirror.status_repasse ?? null,
        idsituacao_repasse: repasseMirror.idsituacao_repasse ?? null,
        data_status_repasse: repasseMirror.data_status_repasse ? toDate(repasseMirror.data_status_repasse) : null,

        // Denormalizações
        documento: titular?.documento ?? null,
        empreendimento: unidade?.empreendimento ?? null,
        etapa: unidade?.etapa ?? null,
        bloco: unidade?.bloco ?? null,
        unidade: unidade?.unidade ?? null,

        // Blocos
        situacao: core?.situacao ?? null,
        imobiliaria: core?.imobiliaria ?? null,
        unidade_json: core?.unidade ?? null,
        titular: core?.titular ?? null,
        corretor: core?.corretor ?? null,
        condicoes: core?.condicoes ?? null,
        leads_associados: core?.leads_associados ?? null,

        // “flat” do core
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

        // Extras
        documentos: docs ?? {},
        erp_sienge: erp ?? {},
        campanhas: campanhas ?? [],
        mensagens: mensagens ?? [],
    };
}

// ===================== Concurrency (simples) =====================
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
    async loadAll() {
        await Reserva.sync({ alter: true });
        console.log('🚀 [Reservas] Carga inicial (via Repasse)');

        const base = await Repasse.findAll({
            attributes: [
                'idreserva',
                'status_reserva', 'status_repasse', 'idsituacao_repasse', 'data_status_repasse',
                'documento', 'empreendimento', 'bloco', 'unidade'
            ],
            where: { idreserva: { [Op.ne]: null } },
            raw: true
        });

        const mapById = new Map();
        for (const r of base) if (!mapById.has(r.idreserva)) mapById.set(r.idreserva, r);
        const list = Array.from(mapById.values());
        console.log(`📋 [Reservas] idreserva únicos: ${list.length}`);

        const stats = await this._processList(list);
        console.log(`🎉 [Reservas][FULL] total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        return stats;
    }

    async loadDelta(sinceDate) {
        await Reserva.sync({ alter: true });
        let since = sinceDate || new Date(Date.now() - DEFAULT_LOOKBACK_MIN * 60_000);
        console.log(`🚀 [Reservas] Delta desde ${since.toISOString()}`);

        const base = await Repasse.findAll({
            attributes: [
                'idreserva',
                'status_reserva', 'status_repasse', 'idsituacao_repasse', 'data_status_repasse',
                'documento', 'empreendimento', 'bloco', 'unidade'
            ],
            where: {
                idreserva: { [Op.ne]: null },
                updatedAt: { [Op.gte]: since }
            },
            raw: true
        });

        const mapById = new Map();
        for (const r of base) if (!mapById.has(r.idreserva)) mapById.set(r.idreserva, r);
        const list = Array.from(mapById.values());
        console.log(`📋 [Reservas][DELTA] impactados: ${list.length}`);

        const stats = await this._processList(list);
        console.log(`🎉 [Reservas][DELTA] total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        return stats;
    }

    async _processList(list) {
        let created = 0, updated = 0, unchanged = 0, failed = 0;

        for (let i = 0; i < list.length; i += RESERVA_CHUNK) {
            const slice = list.slice(i, i + RESERVA_CHUNK);

            await processWithLimit(slice, RESERVA_CONCURRENCY, async (repasseRow) => {
                const idreserva = repasseRow.idreserva;
                if (!idreserva) { failed++; return; }

                try {
                    // 0) snapshot (do repasse)
                    const snap = buildSnapshotFromRepasse(repasseRow);

                    // 1) verifica se já existe e se o status mudou
                    const existing = await Reserva.findByPk(idreserva);
                    const prevSnap0 = existing?.status?.[0] || null;
                    const statusChanged = !existing || !snapshotsEqual(prevSnap0, snap);

                    if (!statusChanged) {
                        // nada mudou -> NÃO chama a API (economia real)
                        unchanged++;
                        return;
                    }

                    // 2) mudou OU não existe -> buscar API (em série, respeitando rate limit)
                    const core = await fetchReservaCore(idreserva);
                    if (!core) { failed++; return; } // reserva pode ter sido removida/indisponível

                    const docs = await fetchReservaDocumentos(idreserva);
                    const erp = await fetchReservaErpSienge(idreserva);
                    const campanhas = await fetchReservaCampanhas(idreserva);
                    const mensagens = await fetchReservaMensagensAll(idreserva);

                    // 3) map + upsert
                    const mapped = mapReservaToCols(idreserva, core, docs, erp, campanhas, mensagens, snap);
                    const now = new Date();

                    if (!existing) {
                        await Reserva.create({
                            ...mapped,
                            status: [snap],
                            first_seen_at: now,
                            last_seen_at: now
                        });
                        created++;
                    } else {
                        const nextStatus = [snap, ...(existing.status || [])];
                        await existing.update({
                            ...mapped,
                            status: nextStatus,
                            last_seen_at: now
                        });
                        updated++;
                    }
                } catch (e) {
                    failed++;
                    console.error(`[Reservas] Falha idreserva=${idreserva}:`, e?.response?.status, e?.response?.data || e.message);
                }
            });

            console.log(`   → reservas progresso: ${Math.min(i + RESERVA_CHUNK, list.length)}/${list.length} | criados=${created} | atualizados=${updated} | mantidos=${unchanged} | falhas=${failed}`);
        }

        return { total: list.length, created, updated, unchanged, failed };
    }
}
