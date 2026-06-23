// services/sienge/payableLiveService.js
//
// Leitura AO VIVO do contas a pagar (títulos/custos) direto do backup diário do
// Sienge restaurado (Postgres `sie214801`, via lib/siengeReadDb.js). Substitui o
// antigo Auto-Sync que buscava tudo na API do Sienge e gravava em sienge_bills /
// sienge_bill_installments / expenses.
//
// Tabelas nativas do Sienge usadas (contas a pagar = prefixo `ecpg`):
//   ecpgtitulo     título (nutitulo, cdcredor, cddocumento, nudocumento, dtemissao,
//                          cdorigem(=sigla), deobservacao, vldesconto, qtparcelas, cdempresa)
//   ecpgparcela    parcela (nutitulo, nuparcela, dtvencto, dtcompetencia, vloriginal, flsituacao)
//   ecpgbaixa      baixa/pagamento (nutitulo, nuparcela, dtpagto, flparcialtotal 'P'/'T')
//   ecpgapropfin   apropriação financeira → cdcentrocusto (= ecadempreend.cdempreend)
//   ecpgapropdepart apropriação por departamento (cddepartamento, peapropriado)
//   ecadcredor     credor (nmcredor, nmfantasia, nucnpj, nucpf, flfisjur)
//   ecaddepartamento nome do departamento (cddepartamento, nmdepartamento, flativo)
//   ecadempreend   empreendimento: cdempreend (interno) ↔ cdempreendview (= costCenterId do Office)
//
// Linkage validado: ecpgapropfin.cdcentrocusto = ecadempreend.cdempreend (100%);
// ecadempreend.cdempreendview é o costCenterId que o Office usa.
//
// Status da parcela via flsituacao: '2' pago, '1' parcial (raro), '0'/demais aberto.
// (Confirmado por amostragem: '2' tem baixa 'T' + dtpagto; '0' sem baixa.)

import { siengeQuery } from '../../lib/siengeReadDb.js';

// Documentos bloqueados (fidelidade ao comportamento antigo do billsService).
const BLOCKED_DOC_IDS = ["'PCT'"]; // usado em NOT IN (...)

// ─── Cache simples em memória (TTL) ──────────────────────────────────────────
const _cache = new Map();
const TTL_MS = Number(process.env.PAYABLE_LIVE_CACHE_TTL_MS || 5 * 60 * 1000);

function cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (hit) _cache.delete(key);
  return null;
}
function cacheSet(key, value) {
  _cache.set(key, { at: Date.now(), value });
  if (_cache.size > 300) {
    for (const [k, v] of _cache) if (Date.now() - v.at >= TTL_MS) _cache.delete(k);
  }
  return value;
}
/** Invalida todo o cache (chamado quando personalizações mudam, p/ refletir na hora). */
export function clearPayableCache() { _cache.clear(); }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toIntArr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((x) => parseInt(x, 10)).filter(Number.isFinite);

/**
 * Agregação de status do título a partir das parcelas:
 *   - todas pagas              → 'paid'
 *   - alguma aberta + paga/parc→ 'partial'
 *   - nenhuma paga             → 'open'
 * Expresso em SQL via FILTER no LATERAL.
 */
const STATUS_AGG_SQL = `
  CASE
    WHEN COUNT(*) FILTER (WHERE st = 'open') = 0
         AND COUNT(*) FILTER (WHERE st = 'partial') = 0 THEN 'paid'
    WHEN COUNT(*) FILTER (WHERE st <> 'open') > 0 THEN 'partial'
    ELSE 'open'
  END`;

// Nível de parcela: só paid/open (igual à semântica atual do Custos — 'partial'
// só existe no agregado do título). flsituacao '2' = liquidada; demais = em aberto.
const PARCELA_STATUS_EXPR = `
  CASE WHEN p.flsituacao = '2' THEN 'paid' ELSE 'open' END`;

// ─────────────────────────────────────────────────────────────────────────────
// 1) TÍTULOS  (tela Títulos — mesmo shape do antigo GET /api/sienge/bills)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lista títulos a pagar dos centros de custo (cdempreendview) no período de EMISSÃO.
 * @param {object} p
 * @param {number[]|string} p.costCenterIds  cdempreendview(s)
 * @param {string} p.startDate YYYY-MM-DD (dtemissao >=)
 * @param {string} p.endDate   YYYY-MM-DD (dtemissao <=)
 * @param {number} [p.debtorId] filtra por empresa (cdempresa) — opcional/raro
 * @returns {Promise<object[]>} bills no shape do front (snake_case + creditor_json)
 */
export async function listBills({ costCenterIds, startDate, endDate, debtorId } = {}) {
  const views = toIntArr(costCenterIds);
  if (!views.length) return [];
  const start = DATE_RE.test(startDate) ? startDate : null;
  const end = DATE_RE.test(endDate) ? endDate : null;
  if (!start || !end) throw new Error('startDate/endDate (YYYY-MM-DD) são obrigatórios.');

  const key = `bills:${views.join(',')}:${start}:${end}:${debtorId || ''}`;
  const cached = cacheGet(key);
  if (cached) return cached.map((b) => ({ ...b }));

  const params = [views, start, end];
  let debtorClause = '';
  if (debtorId != null && Number.isFinite(Number(debtorId))) {
    params.push(Number(debtorId));
    debtorClause = `AND t.cdempresa = $${params.length}`;
  }

  // tit: pares (título, centro de custo view) — título aparece sob CADA CC ao qual
  // está apropriado (fiel ao comportamento da API, que retornava o título por costCenterId).
  const sql = `
    WITH cc AS (
      SELECT cdempreend, cdempreendview FROM ecadempreend WHERE cdempreendview = ANY($1::int[])
    ),
    tit AS (
      SELECT DISTINCT af.nutitulo, cc.cdempreendview AS cost_center_id
      FROM ecpgapropfin af
      JOIN cc ON cc.cdempreend = af.cdcentrocusto
    )
    SELECT
      t.nutitulo                         AS id,
      tit.cost_center_id                 AS cost_center_id,
      t.cdempresa                        AS debtor_id,
      t.cdcredor                         AS creditor_id,
      TRIM(t.cddocumento)                AS document_identification_id,
      t.nudocumento                      AS document_number,
      to_char(t.dtemissao, 'YYYY-MM-DD')  AS issue_date,
      t.qtparcelas                       AS installments_number,
      NULLIF(TRIM(t.cdorigem), '')       AS origin_id,
      t.deobservacao                     AS notes,
      t.vldesconto                       AS discount,
      pt.total_invoice_amount            AS total_invoice_amount,
      dep.main_department_id             AS main_department_id,
      dep.main_department_name           AS main_department_name,
      st.current_status                  AS current_status,
      cr.nmcredor, cr.nmfantasia, cr.nucnpj, cr.nucpf, cr.flfisjur
    FROM tit
    JOIN ecpgtitulo t ON t.nutitulo = tit.nutitulo
    LEFT JOIN ecadcredor cr ON cr.cdcredor = t.cdcredor
    LEFT JOIN LATERAL (
      SELECT SUM(p.vloriginal) AS total_invoice_amount FROM ecpgparcela p WHERE p.nutitulo = t.nutitulo
    ) pt ON true
    LEFT JOIN LATERAL (
      SELECT d.cddepartamento AS main_department_id, dd.nmdepartamento AS main_department_name
      FROM ecpgapropdepart d
      LEFT JOIN ecaddepartamento dd ON dd.cddepartamento = d.cddepartamento
      WHERE d.nutitulo = t.nutitulo
      ORDER BY d.peapropriado DESC NULLS LAST
      LIMIT 1
    ) dep ON true
    LEFT JOIN LATERAL (
      SELECT ${STATUS_AGG_SQL} AS current_status
      FROM (SELECT ${PARCELA_STATUS_EXPR} AS st FROM ecpgparcela p WHERE p.nutitulo = t.nutitulo) s
    ) st ON true
    WHERE t.dtemissao BETWEEN $2::date AND $3::date
      AND TRIM(t.cddocumento) NOT IN (${BLOCKED_DOC_IDS.join(',')})
      ${debtorClause}
    ORDER BY t.dtemissao DESC, t.nutitulo DESC
  `;

  const { rows } = await siengeQuery(sql, params);

  const result = rows.map((r) => ({
    id: r.id,
    cost_center_id: r.cost_center_id,
    debtor_id: r.debtor_id,
    creditor_id: r.creditor_id,
    document_identification_id: r.document_identification_id,
    document_number: r.document_number,
    issue_date: r.issue_date || null,
    installments_number: r.installments_number,
    installment_number: r.installments_number, // compat: front usa installments_number
    origin_id: r.origin_id,
    notes: r.notes,
    discount: r.discount != null ? Number(r.discount) : null,
    total_invoice_amount: r.total_invoice_amount != null ? Number(r.total_invoice_amount) : 0,
    main_department_id: r.main_department_id,
    main_department_name: r.main_department_name,
    current_status: r.current_status || 'open',
    is_settled: r.current_status === 'paid',
    creditor_json: r.creditor_id
      ? {
          id: r.creditor_id,
          name: r.nmcredor,
          tradeName: r.nmfantasia || r.nmcredor,
          cnpj: (r.nucnpj && r.nucnpj.trim()) || (r.nucpf && r.nucpf.trim()) || null,
          personType: r.flfisjur === 'J' ? 'BUSINESS' : r.flfisjur === 'F' ? 'INDIVIDUAL' : null,
        }
      : null,
  }));

  return cacheSet(key, result).map((b) => ({ ...b }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) CUSTOS  (linhas de parcela — base do summarizeAllMonth do expenseService)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linhas de "expense" (uma por parcela) no período de COMPETÊNCIA (mês do vencimento,
 * fiel ao comportamento atual do Custos). Cada parcela é atribuída ao CENTRO DE CUSTO
 * PRINCIPAL do título (maior peparticipacao em ecpgapropfin) para não inflar totais.
 *
 * Retorna linhas planas do backup (sem merge office-side de nome/categoria/oculto —
 * isso fica no expenseService, que reaproveita a resolução de nome existente).
 *
 * @returns {Promise<object[]>} cada item: { billId, installmentNumber, costCenterId, ... , bill:{...} }
 */
export async function listExpenseRows({ startDate, endDate, costCenterId } = {}) {
  const start = DATE_RE.test(startDate) ? startDate : null;
  const end = DATE_RE.test(endDate) ? endDate : null;
  if (!start || !end) throw new Error('startDate/endDate (YYYY-MM-DD) são obrigatórios.');

  const params = [start, end];
  let ccClause = '';
  if (costCenterId != null && Number.isFinite(Number(costCenterId))) {
    params.push(Number(costCenterId));
    ccClause = `AND main_cc.cost_center_id = $${params.length}`;
  }

  const key = `exprows:${start}:${end}:${costCenterId || ''}`;
  const cached = cacheGet(key);
  if (cached) return cached.map((r) => ({ ...r, bill: { ...r.bill } }));

  // main_cc: o CC principal (view) de cada título — 1 linha por título.
  const sql = `
    WITH main_cc AS (
      SELECT af.nutitulo, e.cdempreendview AS cost_center_id
      FROM (
        SELECT DISTINCT ON (nutitulo) nutitulo, cdcentrocusto
        FROM ecpgapropfin
        ORDER BY nutitulo, peparticipacao DESC NULLS LAST
      ) af
      JOIN ecadempreend e ON e.cdempreend = af.cdcentrocusto
    )
    SELECT
      p.nutitulo                         AS bill_id,
      p.nuparcela                        AS installment_number,
      t.qtparcelas                       AS installments_number,
      main_cc.cost_center_id             AS cost_center_id,
      p.vloriginal                       AS amount,
      to_char(date_trunc('month', COALESCE(p.dtvencto, p.dtcompetencia, t.dtemissao)), 'YYYY-MM-DD') AS competence_month,
      to_char(p.dtvencto, 'YYYY-MM-DD')  AS due_date,
      ${PARCELA_STATUS_EXPR}             AS status,
      to_char(bx.dtpagto, 'YYYY-MM-DD')  AS paid_at,
      -- bill (título) embutido
      to_char(t.dtemissao, 'YYYY-MM-DD') AS bill_issue_date,
      TRIM(t.cddocumento)                AS bill_doc_id,
      t.nudocumento                      AS bill_doc_number,
      t.deobservacao                     AS bill_notes,
      tt.total_invoice_amount            AS bill_total,
      t.qtparcelas                       AS bill_installments_number,
      dep.main_department_id             AS department_id,
      dep.main_department_name           AS department_name,
      cr.cdcredor AS creditor_id, cr.nmcredor, cr.nmfantasia, cr.nucnpj, cr.nucpf, cr.flfisjur
    FROM ecpgparcela p
    JOIN main_cc ON main_cc.nutitulo = p.nutitulo
    JOIN ecpgtitulo t ON t.nutitulo = p.nutitulo
    LEFT JOIN ecadcredor cr ON cr.cdcredor = t.cdcredor
    LEFT JOIN LATERAL (
      SELECT SUM(pp.vloriginal) AS total_invoice_amount FROM ecpgparcela pp WHERE pp.nutitulo = t.nutitulo
    ) tt ON true
    LEFT JOIN LATERAL (
      SELECT d.cddepartamento AS main_department_id, dd.nmdepartamento AS main_department_name
      FROM ecpgapropdepart d
      LEFT JOIN ecaddepartamento dd ON dd.cddepartamento = d.cddepartamento
      WHERE d.nutitulo = t.nutitulo
      ORDER BY d.peapropriado DESC NULLS LAST
      LIMIT 1
    ) dep ON true
    LEFT JOIN LATERAL (
      SELECT MAX(b.dtpagto) AS dtpagto
      FROM ecpgbaixa b
      WHERE b.nutitulo = p.nutitulo AND b.nuparcela = p.nuparcela
        AND b.flparcialtotal = 'T' AND b.nuseqestorno IS NULL
    ) bx ON true
    WHERE date_trunc('month', COALESCE(p.dtvencto, p.dtcompetencia, t.dtemissao))
            BETWEEN date_trunc('month', $1::date) AND $2::date
      AND TRIM(t.cddocumento) NOT IN (${BLOCKED_DOC_IDS.join(',')})
      ${ccClause}
    ORDER BY main_cc.cost_center_id, p.nutitulo, p.nuparcela
  `;

  const { rows } = await siengeQuery(sql, params);

  const result = rows.map((r) => ({
    // id sintético estável p/ v-for/edição: "<nutitulo>-<nuparcela>"
    id: `${r.bill_id}-${r.installment_number}`,
    billId: r.bill_id,
    installmentNumber: r.installment_number,
    installmentsNumber: r.installments_number,
    costCenterId: r.cost_center_id,
    amount: r.amount != null ? Number(r.amount) : 0,
    competenceMonth: r.competence_month,
    dueDate: r.due_date || null,
    status: r.status || 'open',
    paidAt: r.paid_at || null,
    departmentId: r.department_id,
    departmentName: r.department_name,
    bill: {
      id: r.bill_id,
      issueDate: r.bill_issue_date || null,
      totalInvoiceAmount: r.bill_total != null ? Number(r.bill_total) : 0,
      mainDepartmentName: r.department_name,
      notes: r.bill_notes,
      document_identification_id: r.bill_doc_id,
      document_number: r.bill_doc_number,
      installmentNumber: Number(r.bill_installments_number || 0),
      installmentsNumber: Number(r.bill_installments_number || 0),
      currentStatus: r.status || 'open',
      isSettled: r.status === 'paid',
      creditor_json: r.creditor_id
        ? {
            id: r.creditor_id,
            name: r.nmcredor,
            tradeName: r.nmfantasia || r.nmcredor,
            cnpj: (r.nucnpj && r.nucnpj.trim()) || (r.nucpf && r.nucpf.trim()) || null,
          }
        : null,
    },
  }));

  return cacheSet(key, result).map((r) => ({ ...r, bill: { ...r.bill } }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Viabilidade — gasto por mês (competência) por departamento, vida toda até endDate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linhas agregadas (mês, departamento) para os centros de custo, com competência
 * (mês do vencimento) ANTERIOR a endDate. Exclui o que não tem departamento? Não —
 * mantém department_name (pode ser null). Não há "cancelado" no backup, então não
 * há filtro de status.
 * @returns {Promise<Array<{ym:string, departmentName:string|null, amount:number}>>}
 */
export async function listMarketingSpendByMonth({ costCenterIds, endDate } = {}) {
  const views = toIntArr(costCenterIds);
  if (!views.length) return [];
  const end = DATE_RE.test(endDate) ? endDate : null;
  if (!end) throw new Error('endDate (YYYY-MM-DD) é obrigatório.');

  const key = `mkt:${views.join(',')}:${end}`;
  const cached = cacheGet(key);
  if (cached) return cached.map((r) => ({ ...r }));

  const sql = `
    WITH main_cc AS (
      SELECT af.nutitulo, e.cdempreendview AS cost_center_id
      FROM (
        SELECT DISTINCT ON (nutitulo) nutitulo, cdcentrocusto
        FROM ecpgapropfin ORDER BY nutitulo, peparticipacao DESC NULLS LAST
      ) af
      JOIN ecadempreend e ON e.cdempreend = af.cdcentrocusto
      WHERE e.cdempreendview = ANY($1::int[])
    )
    SELECT
      to_char(date_trunc('month', COALESCE(p.dtvencto, p.dtcompetencia, t.dtemissao)), 'YYYY-MM') AS ym,
      dep.main_department_name AS department_name,
      SUM(p.vloriginal) AS amount
    FROM ecpgparcela p
    JOIN main_cc ON main_cc.nutitulo = p.nutitulo
    JOIN ecpgtitulo t ON t.nutitulo = p.nutitulo
    LEFT JOIN LATERAL (
      SELECT dd.nmdepartamento AS main_department_name
      FROM ecpgapropdepart d
      LEFT JOIN ecaddepartamento dd ON dd.cddepartamento = d.cddepartamento
      WHERE d.nutitulo = t.nutitulo
      ORDER BY d.peapropriado DESC NULLS LAST LIMIT 1
    ) dep ON true
    WHERE date_trunc('month', COALESCE(p.dtvencto, p.dtcompetencia, t.dtemissao)) < $2::date
      AND TRIM(t.cddocumento) NOT IN (${BLOCKED_DOC_IDS.join(',')})
    GROUP BY 1, 2
  `;
  const { rows } = await siengeQuery(sql, [views, end]);
  const result = rows.map((r) => ({
    ym: r.ym,
    departmentName: r.department_name,
    amount: Number(r.amount) || 0,
  }));
  return cacheSet(key, result).map((r) => ({ ...r }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Vínculos por título (substitui listLinksByBill) e nomes de departamento ativos
// ─────────────────────────────────────────────────────────────────────────────

/** Contagem/soma de parcelas por título (para a tela Títulos mostrar "X custos"). */
export async function listLinkRows({ billIds } = {}) {
  const ids = toIntArr(billIds);
  if (!ids.length) return [];
  const { rows } = await siengeQuery(
    `SELECT p.nutitulo AS bill_id, COUNT(*) AS count, SUM(p.vloriginal) AS total
       FROM ecpgparcela p WHERE p.nutitulo = ANY($1::int[]) GROUP BY p.nutitulo`,
    [ids]
  );
  return rows.map((r) => ({ billId: r.bill_id, count: Number(r.count) || 0, total: Number(r.total) || 0 }));
}

/** Nomes de departamentos ativos (substitui SELECT DISTINCT department_name FROM expenses). */
export async function listActiveDepartmentNames() {
  const key = 'deptnames';
  const cached = cacheGet(key);
  if (cached) return [...cached];
  const { rows } = await siengeQuery(
    `SELECT nmdepartamento AS name FROM ecaddepartamento
      WHERE flativo = 'S' AND COALESCE(TRIM(nmdepartamento),'') <> ''
      ORDER BY nmdepartamento`
  );
  const names = rows.map((r) => r.name);
  return [...cacheSet(key, names)];
}

export default {
  listBills,
  listExpenseRows,
  listMarketingSpendByMonth,
  listLinkRows,
  listActiveDepartmentNames,
  clearPayableCache,
};
