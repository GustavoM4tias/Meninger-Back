// services/bulkData/cv/PriceTableSyncService.js
//
// Fluxo:
//   1. GET /tabelasdepreco/detalhada?tabelasemjson=true
//      → retorna { tabelas: [{ idtabela, tabela, dados: [...unidades] }] }
//      → extrai IDs e dados de unidades
//
//   2. Para cada idtabela, GET /tabelasdepreco/{idTabela}
//      → retorna metadados completos: vigência, forma, parcelas, juros, etc.
//
//   3. Merge + upsert em cv_enterprise_price_tables

import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';
import crypto from 'crypto';

const { CvEnterprise, CvEnterprisePriceTable } = db;

// ─── logging ──────────────────────────────────────────────────────────────────

const tag    = (eid) => `[PriceTables:${eid}]`;
const log    = (eid, msg) => console.log(`${tag(eid)} ${msg}`);
const logObj = (eid, msg, obj) => console.log(`${tag(eid)} ${msg}`, JSON.stringify(obj, null, 2));
const warn   = (eid, msg) => console.warn(`${tag(eid)} ⚠ ${msg}`);
const error  = (eid, msg, err) => console.error(`${tag(eid)} ✖ ${msg}`, err?.message ?? err);

// ─── helpers ──────────────────────────────────────────────────────────────────

function sha(obj) {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// "220.000,00" → 220000.00
function parseBrNumber(s) {
    if (s == null) return null;
    if (typeof s === 'number') return s;
    const cleaned = String(s).replace(/\./g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
}

// "2019-01-23" ou "23/01/2019" → Date ou null
function parseDate(s) {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s);
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const [d, m, y] = s.split('/');
        return new Date(`${y}-${m}-${d}`);
    }
    return null;
}

// ─── Etapa 0: descobre todos os IDs via endpoint base ────────────────────────

async function fetchAllTableIds(idempreendimento) {
    const eid = idempreendimento;
    const known = new Map(); // idtabela → nome
    try {
        const res = await apiCv.get(
            `/v1/cadastros/empreendimentos/${idempreendimento}/tabelasdepreco`
        );
        const data = res.data;
        const items = Array.isArray(data)           ? data :
                      Array.isArray(data?.tabelas)  ? data.tabelas :
                      Array.isArray(data?.dados)    ? data.dados :
                      Array.isArray(data?.data)     ? data.data : [];
        for (const t of items) {
            const id = t.idtabela ?? t.id;
            if (id) known.set(id, t.tabela ?? t.nome ?? `Tabela #${id}`);
        }
        log(eid, `Endpoint base → ${known.size} ID(s) encontrado(s): [${[...known.keys()].join(', ')}]`);
    } catch (e) {
        warn(eid, `Endpoint base falhou (${e?.message}) — continuando só com /detalhada`);
    }
    return known;
}

// ─── Etapa 1: busca tabelas ativas com dados de unidades inline ──────────────
// Retorna Map<idtabela, { nome, unidades[] }>

async function fetchDetailedTables(idempreendimento) {
    const eid = idempreendimento;
    log(eid, `Buscando dados de unidades (endpoint detalhada)...`);

    const detailed = new Map(); // idtabela → { nome, unidades }

    const paramSets = [
        { tabelasemjson: true, resetar: 'S' },
        { tabelasemjson: true, resetar: 'S', aprovado: 'N' },
    ];

    for (const params of paramSets) {
        let res;
        try {
            res = await apiCv.get(
                `/v1/cadastros/empreendimentos/${idempreendimento}/tabelasdepreco/detalhada`,
                { params }
            );
        } catch (e) {
            warn(eid, `Detalhada falhou (params=${JSON.stringify(params)}): ${e?.message}`);
            if (e?.response) warn(eid, `  status=${e.response.status}`);
            continue;
        }

        const tabelas = res.data?.tabelas ?? res.data?.links ?? res.data?.dados ?? [];
        if (!Array.isArray(tabelas)) {
            warn(eid, `Resposta inesperada (params=${JSON.stringify(params)}): ${JSON.stringify(res.data).substring(0, 300)}`);
            continue;
        }

        log(eid, `  params=${JSON.stringify(params)} → ${tabelas.length} tabela(s)`);

        for (const t of tabelas) {
            if (!t || typeof t !== 'object') continue;
            const idtabela = t.idtabela ?? t.id;
            if (!idtabela || detailed.has(idtabela)) continue;

            const unidades = (t.dados ?? t.unidades ?? []).map(u => ({
                etapa:          u.etapa ?? null,
                bloco:          u.bloco ?? null,
                unidade:        u.unidade ?? null,
                idunidade:      u.idunidade ?? null,
                area_privativa: parseBrNumber(u.area_privativa),
                situacao:       u.situacao ?? null,
                valor_total:    parseBrNumber(u.valor_total),
                series: (u.series ?? []).map(s => ({
                    nome:            s.nome,
                    qtd_parcelas:    s.qtd_parcelas,
                    data_vencimento: s.data_vencimento,
                    valor:           parseBrNumber(s.valor),
                })),
            }));

            detailed.set(idtabela, {
                nome: t.tabela ?? t.nome ?? `Tabela #${idtabela}`,
                unidades,
            });
        }
    }

    return detailed;
}

// ─── Merge: todos os IDs conhecidos + dados de unidades onde disponível ───────

async function fetchTablesWithData(idempreendimento) {
    const eid = idempreendimento;

    const [allIds, detailed] = await Promise.all([
        fetchAllTableIds(idempreendimento),
        fetchDetailedTables(idempreendimento),
    ]);

    // Union de todas as fontes
    const merged = new Map([...allIds.entries()].map(([id, nome]) => [id, { nome, unidades: [] }]));
    for (const [id, data] of detailed.entries()) {
        merged.set(id, data); // sobrescreve com dados completos (tem unidades)
    }

    const result = [...merged.entries()].map(([idtabela, data]) => ({ idtabela, ...data }));
    log(eid, `Total após merge: ${result.length} tabela(s) — IDs: [${result.map(t => t.idtabela).join(', ')}]`);
    return result;
}

// ─── Etapa 2: busca metadados completos de cada tabela ───────────────────────

async function fetchTableMetadata(idempreendimento, idtabela) {
    const eid = idempreendimento;
    try {
        const res = await apiCv.get(
            `/v1/cadastros/empreendimentos/${idempreendimento}/tabelasdepreco/${idtabela}`
        );
        const raw = res.data ?? null;
        // CV returns an array; grab first element
        return Array.isArray(raw) ? (raw[0] ?? null) : raw;
    } catch (e) {
        warn(eid, `Metadados da tabela ${idtabela} falhou: ${e?.message}`);
        return null;
    }
}

// ─── Etapa 3: upsert ──────────────────────────────────────────────────────────

async function upsertTable(idempreendimento, idtabela, tableData, meta, unidades) {
    const eid = idempreendimento;

    // Infere formas de pagamento das series da primeira unidade disponível
    const series0 = unidades[0]?.series ?? [];
    // "forma" pode ser nulo no CV; fallback para "tipo" (ex: "Dinâmica (Valor unidades)")
    const formaStr = series0.map(s => s.nome).join(' / ') || meta?.forma || meta?.tipo || null;
    const maxParcelas = Math.max(
        ...(series0.map(s => s.qtd_parcelas ?? 0)),
        meta?.quantidade_parcelas_permitidas_max ?? 0,
    ) || null;

    const raw = {
        idtabela,
        idempreendimento,
        nome:     meta?.tabela ?? tableData.nome,
        forma:    meta?.forma ?? meta?.tipo ?? formaStr,
        metadados: meta ?? null,
        unidades,
    };

    const h = sha(raw);
    const existing = await CvEnterprisePriceTable.findByPk(idtabela);
    if (existing && existing.content_hash === h) {
        log(eid, `  tabela ${idtabela} "${raw.nome}": sem alteração — skip`);
        return;
    }

    const data = {
        idtabela,
        idempreendimento,
        nome:                    meta?.tabela ?? tableData.nome,
        forma:                   meta?.forma ?? meta?.tipo ?? formaStr,
        ativo_painel:            true,
        aprovado:                meta?.aprovado != null ? Boolean(meta.aprovado) : true,
        data_vigencia_de:        parseDate(meta?.data_vigencia_de),
        data_vigencia_ate:       parseDate(meta?.data_vigencia_ate),
        porcentagem_comissao:    null,   // não exposto diretamente pelo CV neste endpoint
        maximo_parcelas:         maxParcelas,
        quantidade_parcelas_min: meta?.quantidade_parcelas_permitidas_min ?? null,
        quantidade_parcelas_max: meta?.quantidade_parcelas_permitidas_max ?? maxParcelas,
        valor_metro:             null,
        juros_mes:               meta?.juros_vpl_mensal ?? null,
        referencia_comissao:     null,
        raw,
        content_hash:            h,
    };

    if (!existing) {
        await CvEnterprisePriceTable.create(data);
        log(eid, `  tabela ${idtabela} "${data.nome}": INSERIDA | vigência ${data.data_vigencia_de?.toISOString().substring(0,10) ?? '?'} → ${data.data_vigencia_ate?.toISOString().substring(0,10) ?? '?'} | ${unidades.length} unidades`);
    } else {
        await existing.update(data);
        log(eid, `  tabela ${idtabela} "${data.nome}": ATUALIZADA | ${unidades.length} unidades`);
    }
}

// ─── service ──────────────────────────────────────────────────────────────────

export default class PriceTableSyncService {

    async syncForEnterprise(idempreendimento) {
        const eid = idempreendimento;
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${tag(eid)} 🔄 Sync iniciado — empreendimento ${eid}`);
        console.log(`${'─'.repeat(60)}`);

        // 1. Busca tabelas com dados de unidades
        const tables = await fetchTablesWithData(idempreendimento);

        if (!tables.length) {
            warn(eid, `Nenhuma tabela encontrada. Verifique:`);
            warn(eid, `  1. O empreendimento tem tabelas de preço no CV?`);
            warn(eid, `  2. As credenciais CV_API_EMAIL / CV_API_TOKEN estão corretas?`);
            warn(eid, `  3. Use GET /cv/price-tables/debug/${eid} para inspecionar a resposta bruta`);
            return 0;
        }

        let synced = 0;

        for (const table of tables) {
            const { idtabela, unidades } = table;
            log(eid, `Processando tabela ${idtabela} "${table.nome}"...`);

            // 2. Busca metadados completos (vigência, forma, juros, parcelas)
            const meta = await fetchTableMetadata(idempreendimento, idtabela);
            if (meta) {
                log(eid, `  metadados: vigência ${meta.data_vigencia_de ?? '?'} → ${meta.data_vigencia_ate ?? '?'} | forma: ${meta.forma ?? '?'}`);
            } else {
                warn(eid, `  metadados indisponíveis para tabela ${idtabela} — salvando sem eles`);
            }

            // 3. Upsert
            await upsertTable(idempreendimento, idtabela, table, meta, unidades);
            synced++;
        }

        console.log(`${'─'.repeat(60)}`);
        console.log(`${tag(eid)} ✅ Sync concluído — ${synced} tabelas processadas`);
        console.log(`${'─'.repeat(60)}\n`);
        return synced;
    }

    async syncAll() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[PriceTables] 🔄 Sync GLOBAL iniciado`);
        console.log(`${'═'.repeat(60)}`);

        const enterprises = await CvEnterprise.findAll({ attributes: ['idempreendimento'] });
        let total = 0;

        for (const ent of enterprises) {
            try {
                const n = await this.syncForEnterprise(ent.idempreendimento);
                total += n;
            } catch (err) {
                console.error(`[PriceTables:${ent.idempreendimento}] ✖ Erro inesperado:`, err?.message ?? err);
            }
            await new Promise(r => setTimeout(r, 500));
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[PriceTables] ✅ Sync global concluído — ${total} tabelas`);
        console.log(`${'═'.repeat(60)}\n`);
        return total;
    }
}
