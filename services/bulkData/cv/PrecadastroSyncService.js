// services/bulkData/cv/PrecadastroSyncService.js
//
// Sync simples e rápido de pré-cadastros do CV para `cv_precadastros`.
// Apenas /v1/comercial/precadastro (listar paginado) — sem documentos.
//
// Fluxo:
//   1) Pré-carrega TODOS os hashes existentes em 1 SELECT.
//   2) Varre listar paginado.
//   3) Para cada item:
//        - hash igual    → bulk UPDATE last_seen_at
//        - hash diferente → UPDATE individual com novos dados
//        - novo           → bulkCreate
//
// Para 11k registros: ~22-30s no total (sem chamadas extras).

import crypto from 'crypto';
import db from '../../../models/sequelize/index.js';
import apiCv from '../../../lib/apiCv.js';

const { CvPrecadastro } = db;

// ===================== Config =====================
const LIST_LIMIT       = parseInt(process.env.PRECADASTRO_LIST_LIMIT || '1000', 10);
const UPSERT_CHUNK     = parseInt(process.env.PRECADASTRO_UPSERT_CHUNK || '300', 10);
const MIN_TIME_MS      = parseInt(process.env.CVCRM_MIN_TIME_MS || '200', 10);
const MAX_RETRIES      = parseInt(process.env.CVCRM_MAX_RETRIES || '5', 10);
const BASE_BACKOFF_MS  = parseInt(process.env.CVCRM_BASE_BACKOFF_MS || '500', 10);
const MAX_BACKOFF_MS   = parseInt(process.env.CVCRM_MAX_BACKOFF_MS || '8000', 10);
const JITTER_MS        = parseInt(process.env.CVCRM_JITTER_MS || '250', 10);

// ===================== Utils =====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

function toDate(s) {
    if (!s) return null;
    const str = String(s).replace(' ', 'T');
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}
function toDec(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
}

// ===================== Rate limit (serial, simples) =====================
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
            console.warn(`[Precadastros][HTTP RETRY] ${path} status=${status} attempt=${attempt} wait=${backoff}ms`);
            await sleep(backoff);
            return getWithRetry(path, config, attempt + 1);
        }
        throw e;
    }
}

function rateLimited(fn) {
    const run = async () => {
        const now = Date.now();
        const wait = Math.max(0, MIN_TIME_MS - (now - _lastTs));
        if (wait) await sleep(wait);
        _lastTs = Date.now();
        return fn();
    };
    const p = _rlQueue.then(run, run);
    _rlQueue = p.catch(() => { });
    return p;
}

const httpGet = (path, config) => rateLimited(() => getWithRetry(path, config));

// ===================== Fetcher =====================
async function fetchListPage(pagina) {
    const { data } = await httpGet('/v1/comercial/precadastro', {
        params: { pagina, limite: LIST_LIMIT },
    });
    return data || {};
}

// ===================== Map =====================
function buildSnapshot(raw) {
    const sit = raw?.situacao || {};
    return {
        idsituacao: sit.id ?? null,
        situacao_nome: sit.nome ?? null,
        valor_aprovado: raw?.valor_aprovado ?? null,
        data_fim: raw?.data_fim ?? null,
        data_cancelamento: raw?.data_cancelamento ?? null,
        captured_at: new Date().toISOString(),
    };
}

function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    return (
        String(a.idsituacao ?? '')        === String(b.idsituacao ?? '') &&
        (a.situacao_nome ?? null)         === (b.situacao_nome ?? null) &&
        String(a.valor_aprovado ?? '')    === String(b.valor_aprovado ?? '') &&
        String(a.data_fim ?? '')          === String(b.data_fim ?? '') &&
        String(a.data_cancelamento ?? '') === String(b.data_cancelamento ?? '')
    );
}

function mapRawToCols(raw) {
    const cliente = raw?.cliente || {};
    return {
        idprecadastro: raw.idprecadastro,
        codigointerno: raw.codigointerno ?? null,
        documento:     cliente.documento ?? null,
        nome_cliente:  cliente.nome ?? null,
        email_cliente: cliente.email ?? null,

        idempreendimento:         raw?.empreendimento?.id ?? null,
        idunidade:                raw?.unidade?.id ?? null,
        idimobiliaria:            raw?.imobiliaria?.id ?? null,
        idcorretor:               raw?.corretor?.id ?? null,
        idcorrespondente:         raw?.correspondente?.idusuario ?? null,
        idempresa_correspondente: raw?.empresa_correspondente?.idempresa ?? null,
        idsituacao:               raw?.situacao?.id ?? null,
        situacao_nome:            raw?.situacao?.nome ?? null,

        valor_avaliacao: toDec(raw.valor_avaliacao),
        valor_aprovado:  toDec(raw.valor_aprovado),
        valor_subsidio:  toDec(raw.valor_subsidio),
        valor_fgts:      toDec(raw.valor_fgts),
        valor_total:     toDec(raw.valor_total),
        valor_prestacao: toDec(raw.valor_prestacao),
        saldo_devedor:   toDec(raw.saldo_devedor),
        renda_cliente_principal: toDec(raw.renda_cliente_principal),
        renda_total:     toDec(raw.renda_total),

        prazo:                raw.prazo ?? null,
        prazo_financiamento:  raw.prazo_financiamento ?? null,
        tabela:               raw.tabela ?? null,
        carta_credito:        raw.carta_credito ?? null,
        vencimento_aprovacao: raw.vencimento_aprovacao ?? null,
        idintencao_compra:    raw.idintencao_compra ?? null,
        intencao_compra:      raw.intencao_compra ?? null,
        link:                 raw.link ?? null,

        data_cad:          toDate(raw.data_cad),
        data_fim:          toDate(raw.data_fim),
        data_cancelamento: toDate(raw.data_cancelamento),

        empreendimento:        raw.empreendimento ?? null,
        unidade:               raw.unidade ?? null,
        imobiliaria:           raw.imobiliaria ?? null,
        corretor:              raw.corretor ?? null,
        correspondente:        raw.correspondente ?? null,
        empresa_correspondente:raw.empresa_correspondente ?? null,
        situacao:              raw.situacao ?? null,
        cliente:               raw.cliente ?? null,
        usuario_aprovou:       raw.usuario_aprovou ?? null,
        leads_associados:      raw.leads_associados ?? [],
        fator_social:          raw.fator_social ?? [],
        associados:            raw.associados ?? null,
        campos_adicionais:     raw.campos_adicionais ?? null,
        mensagem_resumo:       raw.mensagens ?? null, // último resumo do listar

        raw,
    };
}

// ===================== Service =====================
export default class PrecadastroSyncService {
    async loadAll()   { console.log('🚀 [Precadastros] Carga inicial');   return this._run({ forceRefresh: true });  }
    async loadDelta() { console.log('🚀 [Precadastros] Delta');           return this._run({ forceRefresh: false }); }

    async _run({ forceRefresh }) {
        const t0 = Date.now();
        let total = 0, created = 0, updated = 0, unchanged = 0, failed = 0;

        // 1) Pré-carrega hashes existentes (1 query)
        const allRows = await CvPrecadastro.findAll({
            attributes: ['idprecadastro', 'content_hash', 'status_historico'],
            raw: true,
        });
        const existing = new Map();
        for (const r of allRows) existing.set(r.idprecadastro, r);
        console.log(`📦 [Precadastros] hashes em memória: ${existing.size}`);

        // 2) Primeira página → descobre total
        const first = await fetchListPage(1);
        const totalRegistros = Number(first?.total ?? 0);
        const limiteApi = Number(first?.limite ?? LIST_LIMIT);
        const totalPaginas = Math.max(1, Math.ceil(totalRegistros / limiteApi));
        console.log(`📋 [Precadastros] total=${totalRegistros} | páginas=${totalPaginas} | limite=${limiteApi}`);

        const processPage = async (pagina, lista) => {
            const newRecords = [];
            const changedRecords = [];
            const unchangedIds = [];

            for (const raw of lista) {
                const id = raw?.idprecadastro;
                if (!id) { failed++; continue; }
                total++;

                const newHash = sha(raw);
                const ex = existing.get(id);

                if (!ex) {
                    newRecords.push({ raw, newHash });
                } else if (forceRefresh || ex.content_hash !== newHash) {
                    changedRecords.push({ raw, newHash, prev: ex });
                } else {
                    unchangedIds.push(id);
                }
            }

            // Inalterados → bulk UPDATE last_seen_at (1 SQL)
            if (unchangedIds.length) {
                await CvPrecadastro.update(
                    { last_seen_at: new Date() },
                    { where: { idprecadastro: unchangedIds } }
                );
                unchanged += unchangedIds.length;
            }

            // Novos → bulkCreate em chunks
            if (newRecords.length) {
                const built = newRecords.map(({ raw, newHash }) => {
                    const mapped = mapRawToCols(raw);
                    const now = new Date();
                    return {
                        ...mapped,
                        status_historico: [buildSnapshot(raw)],
                        content_hash: newHash,
                        first_seen_at: now,
                        last_seen_at: now,
                    };
                });
                for (let i = 0; i < built.length; i += UPSERT_CHUNK) {
                    await CvPrecadastro.bulkCreate(built.slice(i, i + UPSERT_CHUNK), { ignoreDuplicates: true });
                }
                created += built.length;
                for (const r of built) existing.set(r.idprecadastro, { content_hash: r.content_hash });
            }

            // Mudados → UPDATE individual (PK)
            if (changedRecords.length) {
                for (const { raw, newHash, prev } of changedRecords) {
                    const mapped = mapRawToCols(raw);
                    const snap = buildSnapshot(raw);
                    const prev0 = prev.status_historico?.[0] || null;
                    const nextHist = snapshotsEqual(prev0, snap)
                        ? (prev.status_historico || [])
                        : [snap, ...(prev.status_historico || [])];
                    await CvPrecadastro.update(
                        { ...mapped, status_historico: nextHist, content_hash: newHash, last_seen_at: new Date() },
                        { where: { idprecadastro: raw.idprecadastro } }
                    );
                }
                updated += changedRecords.length;
                for (const { raw, newHash } of changedRecords) {
                    existing.set(raw.idprecadastro, { content_hash: newHash });
                }
            }

            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`   → pág ${pagina}/${totalPaginas} | total=${total} | novos=${created} | atualizados=${updated} | mantidos=${unchanged} | falhas=${failed} | ${elapsed}s`);
        };

        await processPage(1, Array.isArray(first?.precadastros) ? first.precadastros : []);
        for (let pagina = 2; pagina <= totalPaginas; pagina++) {
            const page = await fetchListPage(pagina);
            await processPage(pagina, Array.isArray(page?.precadastros) ? page.precadastros : []);
        }

        const stats = { total, created, updated, unchanged, failed, took_s: ((Date.now() - t0) / 1000).toFixed(1) };
        console.log(`🎉 [Precadastros] concluído em ${stats.took_s}s — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        return stats;
    }
}
