// services/sienge/inadimplenciaService.js
//
// Inadimplência de clientes — lê do backup diário do Sienge (sie214801) e
// reproduz FIELMENTE a query do BI da Danielle (títulos atrasados em aberto +
// recebidos em atraso + pagos parcialmente com saldo), com UMA diferença
// intencional aprovada pelo usuário:
//
//   • dias_em_atraso e valor_juros são travados em 0 (GREATEST(...,0)).
//     A query original gera juros negativo em pagamento parcial feito antes do
//     vencimento; aqui isso vira 0.
//
// Tudo o mais é idêntico ao BI: filtros rígidos (empresa 35 fora, lista de CCs
// excluídos, títulos excluídos, tipo_condicao/tipo_documento/conta/tipo_baixa) e
// a correção monetária via ecadindexhist.
//
// A consulta roda ao vivo no backup (sem tabela de sync). Resultado fica em cache
// de memória por ~10 min, pois a fonte só muda 1×/dia (após o restore).

import { siengeQuery } from '../../lib/siengeReadDb.js';

// ─── Constantes fiéis ao BI ─────────────────────────────────────────────────
const EXCLUDED_CCS = [
  17096, 17056, 17900, 2000, 21012, 2821, 2903, 2904, 2905, 2906,
  2910, 2913, 2916, 33038, 33900, 34001, 43001, 47900,
  4901, 4902, 49900, 5001, 55001, 55900, 58001, 61900,
  64001, 71002, 90900, 91900, 92000, 92901, 92913,
  92914, 92916, 92918, 92919, 92924,
];
const EXCLUDED_TITULOS = [
  17350, 17278, 17370, 17347, 17351, 17354,
  17355, 17353, 19213, 20322, 20621,
  20509, 20517, 20518,
];
const ALLOWED_TIPO_BAIXA   = ['Aberto', 'Recebimento', 'Distrato', 'Reparcelamento', 'Pago Parcialmente'];
const BLOCKED_TIPO_CONDICAO = ['LC', 'RF', 'SB', 'SE', 'TX', 'VM'];
const ALLOWED_TIPO_DOCUMENTO = ['ADTO', 'AVC', 'CT', 'TX'];
const ALLOWED_CONTA = ['10101', '10102', '10103', '10104', '10116', '1011101', '10112', '10113', '10212', '11301', '11701', '21402'];

const DEFAULT_START = '2020-01-01'; // mesma âncora do BI

// Whitelist de ordenação do detalhe (evita SQL injection no ORDER BY)
const SORTABLE = {
  valor_atual: 'valor_atual', valor_juros: 'valor_juros', valor_multa: 'valor_multa',
  valor_original: 'valor_original', valor_baixado: 'valor_baixado',
  dias_em_atraso: 'dias_em_atraso', data_vencimento: 'data_vencimento',
  data_emissao: 'data_emissao', nutitulo: 'nutitulo', cod_cliente: 'cod_cliente',
  empresa: 'empresa', centro_de_custo: 'centro_de_custo',
};

// ─── Helpers ────────────────────────────────────────────────────────────────
const sqlIntList = (arr) => arr.map(n => Number(n)).filter(Number.isFinite).join(',');
const sqlStrList = (arr) => arr.map(s => `'${String(s).replace(/'/g, "''")}'`).join(',');

function makeParams() {
  const values = [];
  return {
    add(v) { values.push(v); return '$' + values.length; },
    values,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeFilters(raw = {}) {
  const toIntArr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map(x => parseInt(x, 10)).filter(Number.isFinite);
  const toStrArr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map(x => String(x).trim()).filter(Boolean);

  const startDate = DATE_RE.test(raw.startDate) ? raw.startDate : DEFAULT_START;
  const endDate   = DATE_RE.test(raw.endDate) ? raw.endDate : null; // null → hoje (CURRENT_DATE)

  return {
    startDate,
    endDate,
    empresas: toIntArr(raw.empresas),
    empreendimentos: toIntArr(raw.empreendimentos),
    situacoes: toStrArr(raw.situacoes),
    search: (raw.search ?? '').toString().trim(),
  };
}

/**
 * Monta o prefixo WITH base/dados/grouped com os filtros bindados.
 * `grouped` é exatamente o resultado final do BI (snake_case + clamp).
 */
function buildCte(filters, p, { materializeGrouped = false } = {}) {
  const pStart = p.add(filters.startDate);
  const pEnd   = p.add(filters.endDate); // pode ser null → COALESCE p/ CURRENT_DATE

  // filtros opcionais no nível base
  let baseExtra = '';
  if (filters.empresas.length)        baseExtra += `\n      AND g.cdempresaview = ANY(${p.add(filters.empresas)}::int[])`;
  if (filters.empreendimentos.length) baseExtra += `\n      AND h.cdempreendview = ANY(${p.add(filters.empreendimentos)}::int[])`;

  // filtros opcionais no nível agrupado
  let groupedExtra = '';
  if (filters.situacoes.length) groupedExtra += `\n      AND situacao = ANY(${p.add(filters.situacoes)}::text[])`;
  if (filters.search) {
    const like = p.add('%' + filters.search + '%');
    groupedExtra += `\n      AND (CAST(nutitulo AS text) LIKE ${like} OR CAST(cod_cliente AS text) LIKE ${like} OR COALESCE(unidade,'') ILIKE ${like})`;
  }

  return `
WITH base AS MATERIALIZED (
  SELECT
    a.nutitulo, a.nuparcela, a.dtvencto, a.vloriginal, a.cdtipocondicao, a.cdopercobranca,
    b.dtemissao, b.flinadimplente, b.fljudicie, b.cdcliente, b.cddocumento,
    c.dtrecto, c.vlrecto, c.cdtipobaixa, c.flparcialtotal,
    d.cdconta, e.nuunidade, f.detipobaixa, g.cdempresaview, h.cdempreendview,
    GREATEST(
      CASE WHEN c.dtrecto IS NULL THEN CURRENT_DATE - a.dtvencto - 1
           ELSE c.dtrecto - a.dtvencto - 1 END, 0
    ) AS dias_em_atraso,
    (((j.vlindexador / i.vlindexador) - 1) * a.vloriginal) + a.vloriginal AS valor_atual
  FROM ecrcparcela a
  LEFT JOIN ecrctitulo  b ON b.nutitulo = a.nutitulo
  LEFT JOIN ecrcbaixa   c ON c.nutitulo = a.nutitulo AND c.nuparcela = a.nuparcela
  LEFT JOIN ecrcapropfin d ON d.nutitulo = a.nutitulo
  LEFT JOIN ecrcunidade  e ON e.nutitulo = a.nutitulo
  LEFT JOIN ecadtipobaixa f ON f.cdtipobaixa = c.cdtipobaixa
  INNER JOIN ecadempresa  g ON g.cdempresa = b.cdempresa
  INNER JOIN ecadempreend h ON h.cdempreend = e.cdempreend
  LEFT JOIN ecadindexhist i ON a.cdindexador = i.cdindexador AND a.dtbase = i.dtindexador
  LEFT JOIN (SELECT cdindexador, dtindexador, vlindexador FROM ecadindexhist WHERE flultimo = 'S') j
    ON a.cdindexador = j.cdindexador
  WHERE a.dtvencto >= ${pStart}::date
    AND a.dtvencto <= COALESCE(${pEnd}::date, CURRENT_DATE)
    AND a.dtvencto < CURRENT_DATE
    AND g.cdempresaview <> 35
    AND h.cdempreendview NOT IN (${sqlIntList(EXCLUDED_CCS)})${baseExtra}
),
dados AS (
  -- Em aberto / recebidos em atraso
  SELECT
    b.nutitulo,
    b.nuunidade        AS unidade,
    b.dtemissao        AS data_emissao,
    b.dtvencto         AS data_vencimento,
    COALESCE(b.dtrecto, CURRENT_DATE) AS data_baixa,
    b.dtrecto          AS data_pagamento,
    COALESCE(b.detipobaixa, 'Aberto') AS tipo_baixa,
    b.nuparcela,
    b.cdconta          AS conta,
    CASE WHEN b.flinadimplente='C' THEN 'Cobrança'
         WHEN b.flinadimplente='N' THEN 'Normal'
         WHEN b.fljudicie='S'      THEN 'Sub-judicie'
         ELSE 'Inadimplente' END AS situacao,
    b.cdcliente        AS cod_cliente,
    b.cddocumento      AS tipo_documento,
    b.cdtipocondicao   AS tipo_condicao,
    b.cdempreendview   AS centro_de_custo,
    b.cdopercobranca   AS cod_portador,
    b.vloriginal       AS valor_original,
    b.vlrecto          AS valor_baixado,
    CASE WHEN b.flparcialtotal IS NULL THEN b.valor_atual
         WHEN b.flparcialtotal='P'     THEN b.valor_atual
         ELSE NULL END AS valor_atual,
    b.dias_em_atraso,
    b.cdempresaview    AS empresa,
    CASE WHEN b.dtrecto IS NULL THEN b.valor_atual * 0.02 ELSE NULL END AS valor_multa,
    CASE WHEN b.dtrecto IS NULL
         THEN GREATEST(((b.valor_atual * 0.02) + b.valor_atual) * (0.0003333333 * b.dias_em_atraso), 0)
         ELSE NULL END AS valor_juros
  FROM base b
  WHERE (b.dtrecto > b.dtvencto OR b.dtrecto IS NULL)
    AND NOT (b.flinadimplente = 'S')
    AND (b.flparcialtotal = 'T' OR b.flparcialtotal IS NULL)

  UNION ALL

  -- Pagos parcialmente (saldo em aberto)
  SELECT
    b.nutitulo,
    b.nuunidade,
    b.dtemissao,
    b.dtrecto          AS data_vencimento,
    CURRENT_DATE       AS data_baixa,
    NULL::date         AS data_pagamento,
    'Pago Parcialmente' AS tipo_baixa,
    b.nuparcela,
    b.cdconta,
    CASE WHEN b.flinadimplente='C' THEN 'Cobrança'
         WHEN b.flinadimplente='N' THEN 'Normal'
         WHEN b.fljudicie='S'      THEN 'Sub-judicie'
         ELSE 'Inadimplente' END,
    b.cdcliente,
    b.cddocumento,
    b.cdtipocondicao,
    b.cdempreendview,
    b.cdopercobranca,
    0                  AS valor_original,
    b.vlrecto,
    b.valor_atual - b.vlrecto AS valor_atual,
    b.dias_em_atraso,
    b.cdempresaview,
    (b.valor_atual - b.vlrecto) * 0.02 AS valor_multa,
    GREATEST((((b.valor_atual - b.vlrecto) * 0.02) + (b.valor_atual - b.vlrecto)) * (0.0003333333 * b.dias_em_atraso), 0) AS valor_juros
  FROM base b
  WHERE b.flparcialtotal = 'P'
),
grouped AS ${materializeGrouped ? 'MATERIALIZED ' : ''}(
  SELECT
    nutitulo, unidade, data_emissao, data_vencimento, data_baixa, data_pagamento, tipo_baixa,
    nuparcela, conta, situacao, cod_cliente, tipo_documento, tipo_condicao, centro_de_custo,
    cod_portador, dias_em_atraso, empresa,
    SUM(valor_original) AS valor_original,
    SUM(valor_baixado)  AS valor_baixado,
    SUM(valor_atual)    AS valor_atual,
    SUM(valor_multa)    AS valor_multa,
    SUM(valor_juros)    AS valor_juros
  FROM dados
  WHERE tipo_baixa IN (${sqlStrList(ALLOWED_TIPO_BAIXA)})
    AND nutitulo NOT IN (${sqlIntList(EXCLUDED_TITULOS)})
    AND TRIM(tipo_condicao) NOT IN (${sqlStrList(BLOCKED_TIPO_CONDICAO)})
    AND TRIM(tipo_documento) IN (${sqlStrList(ALLOWED_TIPO_DOCUMENTO)})
    AND TRIM(conta) IN (${sqlStrList(ALLOWED_CONTA)})${groupedExtra}
  GROUP BY
    nutitulo, unidade, data_emissao, data_vencimento, data_baixa, data_pagamento, tipo_baixa,
    nuparcela, conta, situacao, cod_cliente, tipo_documento, tipo_condicao, centro_de_custo,
    cod_portador, dias_em_atraso, empresa
)`;
}

// ─── Cache simples em memória (TTL) ──────────────────────────────────────────
const _cache = new Map(); // key → { at, value }
const TTL_MS = Number(process.env.INADIMPLENCIA_CACHE_TTL_MS || 10 * 60 * 1000);

function cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (hit) _cache.delete(key);
  return null;
}
function cacheSet(key, value) {
  _cache.set(key, { at: Date.now(), value });
  // limpeza preguiçosa para não crescer sem limite
  if (_cache.size > 200) {
    for (const [k, v] of _cache) if (Date.now() - v.at >= TTL_MS) _cache.delete(k);
  }
  return value;
}

// ─── API do service ──────────────────────────────────────────────────────────

/** Opções para os seletores (todas as empresas ≠35 e empreendimentos não excluídos). */
export async function getFilterOptions() {
  const cached = cacheGet('filters');
  if (cached) return cached;

  const [empRes, ccRes] = await Promise.all([
    siengeQuery(`
      SELECT DISTINCT cdempresaview AS code,
             COALESCE(NULLIF(TRIM(nmfantasia), ''), nmempresa) AS name
      FROM ecadempresa
      WHERE cdempresaview <> 35
      ORDER BY name NULLS LAST`),
    siengeQuery(`
      SELECT cdempreendview AS code, nmempreend AS name
      FROM ecadempreend
      WHERE cdempreendview NOT IN (${sqlIntList(EXCLUDED_CCS)})
      ORDER BY nmempreend NULLS LAST`),
  ]);

  return cacheSet('filters', {
    empresas: empRes.rows.map(r => ({ code: r.code, name: r.name })),
    empreendimentos: ccRes.rows.map(r => ({ code: r.code, name: r.name })),
  });
}

/** Dashboard: resumo (KPIs) + aging + quebra por empresa e por empreendimento. */
export async function getDashboard(rawFilters, { refresh = false } = {}) {
  const filters = normalizeFilters(rawFilters);
  const key = 'dash:' + JSON.stringify(filters);
  if (!refresh) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  const p = makeParams();
  const cte = buildCte(filters, p, { materializeGrouped: true });

  const sql = `${cte}
SELECT json_build_object(
  'summary', (SELECT json_build_object(
     'valorAtual',    COALESCE(ROUND(SUM(valor_atual), 2), 0),
     'valorOriginal', COALESCE(ROUND(SUM(valor_original), 2), 0),
     'valorBaixado',  COALESCE(ROUND(SUM(valor_baixado), 2), 0),
     'valorMulta',    COALESCE(ROUND(SUM(valor_multa), 2), 0),
     'valorJuros',    COALESCE(ROUND(SUM(valor_juros), 2), 0),
     'titulos',       COUNT(DISTINCT nutitulo),
     'clientes',      COUNT(DISTINCT cod_cliente),
     'parcelas',      COUNT(*)
   ) FROM grouped),
  'aging', (SELECT COALESCE(json_agg(json_build_object(
       'bucket', bucket, 'valor', valor, 'parcelas', parcelas, 'titulos', titulos
     ) ORDER BY ord), '[]'::json) FROM (
       SELECT ord, bucket,
              COALESCE(ROUND(SUM(valor_atual), 2), 0) AS valor,
              COUNT(*) AS parcelas,
              COUNT(DISTINCT nutitulo) AS titulos
       FROM (
         SELECT *,
           CASE WHEN dias_em_atraso<=30 THEN 1 WHEN dias_em_atraso<=60 THEN 2
                WHEN dias_em_atraso<=90 THEN 3 WHEN dias_em_atraso<=180 THEN 4
                WHEN dias_em_atraso<=360 THEN 5 ELSE 6 END AS ord,
           CASE WHEN dias_em_atraso<=30 THEN '0-30' WHEN dias_em_atraso<=60 THEN '31-60'
                WHEN dias_em_atraso<=90 THEN '61-90' WHEN dias_em_atraso<=180 THEN '91-180'
                WHEN dias_em_atraso<=360 THEN '181-360' ELSE '360+' END AS bucket
         FROM grouped
       ) z GROUP BY ord, bucket
     ) ag),
  'byEmpresa', (SELECT COALESCE(json_agg(json_build_object(
       'empresa', empresa, 'valor', valor, 'titulos', titulos) ORDER BY valor DESC NULLS LAST), '[]'::json) FROM (
       SELECT empresa, COALESCE(ROUND(SUM(valor_atual), 2), 0) AS valor, COUNT(DISTINCT nutitulo) AS titulos
       FROM grouped GROUP BY empresa) be),
  'byEmpreendimento', (SELECT COALESCE(json_agg(json_build_object(
       'cc', cc, 'valor', valor, 'titulos', titulos) ORDER BY valor DESC NULLS LAST), '[]'::json) FROM (
       SELECT centro_de_custo AS cc, COALESCE(ROUND(SUM(valor_atual), 2), 0) AS valor, COUNT(DISTINCT nutitulo) AS titulos
       FROM grouped GROUP BY centro_de_custo) bcc)
) AS payload`;

  const { rows } = await siengeQuery(sql, p.values);
  const payload = rows[0]?.payload || { summary: {}, aging: [], byEmpresa: [], byEmpreendimento: [] };
  payload.filters = filters;
  payload.generatedAt = new Date().toISOString();
  return cacheSet(key, payload);
}

/** Detalhe paginado (uma linha por título+parcela, igual ao BI). */
export async function getDetail(rawFilters, { page = 1, pageSize = 100, sort = 'valor_atual', dir = 'desc' } = {}) {
  const filters = normalizeFilters(rawFilters);
  const sortCol = SORTABLE[sort] || 'valor_atual';
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const lim = Math.min(Math.max(parseInt(pageSize, 10) || 100, 1), 500);
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

  const key = `detail:${JSON.stringify(filters)}:${sortCol}:${sortDir}:${lim}:${off}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const p = makeParams();
  const cte = buildCte(filters, p, { materializeGrouped: true });

  const sql = `${cte}
SELECT
  nutitulo, nuparcela, unidade, data_emissao, data_vencimento, data_pagamento,
  tipo_baixa, conta, situacao, cod_cliente, tipo_documento, tipo_condicao,
  centro_de_custo, cod_portador, dias_em_atraso, empresa,
  ROUND(valor_original, 2) AS valor_original,
  ROUND(valor_baixado, 2)  AS valor_baixado,
  ROUND(valor_atual, 2)    AS valor_atual,
  ROUND(valor_multa, 2)    AS valor_multa,
  ROUND(valor_juros, 2)    AS valor_juros,
  COUNT(*) OVER() AS _total
FROM grouped
ORDER BY ${sortCol} ${sortDir} NULLS LAST, nutitulo, nuparcela
LIMIT ${lim} OFFSET ${off}`;

  const { rows } = await siengeQuery(sql, p.values);
  const total = rows.length ? Number(rows[0]._total) : 0;
  const out = {
    rows: rows.map(({ _total, ...r }) => r),
    total,
    page: Math.max(parseInt(page, 10) || 1, 1),
    pageSize: lim,
  };
  return cacheSet(key, out);
}

/** Conjunto completo (sem paginação) para exportação CSV. */
export async function getAllRows(rawFilters) {
  const filters = normalizeFilters(rawFilters);
  const p = makeParams();
  const cte = buildCte(filters, p, { materializeGrouped: false });
  const sql = `${cte}
SELECT
  nutitulo, nuparcela, unidade, data_emissao, data_vencimento, data_pagamento,
  tipo_baixa, conta, situacao, cod_cliente, tipo_documento, tipo_condicao,
  centro_de_custo, cod_portador, dias_em_atraso, empresa,
  ROUND(valor_original, 2) AS valor_original,
  ROUND(valor_baixado, 2)  AS valor_baixado,
  ROUND(valor_atual, 2)    AS valor_atual,
  ROUND(valor_multa, 2)    AS valor_multa,
  ROUND(valor_juros, 2)    AS valor_juros
FROM grouped
ORDER BY valor_atual DESC NULLS LAST, nutitulo, nuparcela`;
  const { rows } = await siengeQuery(sql, p.values);
  return rows;
}

export default { getFilterOptions, getDashboard, getDetail, getAllRows };
