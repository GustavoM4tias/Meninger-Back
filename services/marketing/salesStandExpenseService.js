// services/marketing/salesStandExpenseService.js
//
// O GASTO do Stand de Vendas: o que o Sienge diz que foi gasto com o stand,
// lançamento a lançamento, e a régua que separa construção, recorrência e
// gasto esporádico.
//
// ── O QUE CONTA COMO GASTO DE STAND ──────────────────────────────────────────
// A pergunta é de negócio, então a resposta mora em sales_stand_settings e se
// edita na tela (`expense_source`):
//
//   'departamento' → o título tem apropriação no departamento Stand de Vendas
//                    (padrão). Quem lançou o título é quem decide, e o valor
//                    entra RATEADO pelo percentual dessa apropriação.
//   'plano'        → o título está apropriado numa conta do plano 2.02.07.
//   'ambos'        → as duas coisas juntas (a régua mais apertada).
//
// Em qualquer modo as CONTAS do plano continuam servindo para CATEGORIZAR o
// gasto — é delas que sai o tipo padrão de cada lançamento.
//
// Régua de caixa idêntica à do payableLiveService (a mesma da tela de Custos):
// baixas tipo 1 (pagamento) e 10 (adiantamento), sem estorno, líquido
// desembolsado (principal + juros + multa + correção − desconto), documento PCT
// fora, rateio pelo peparticipacao da apropriação financeira.
//
// ── CLASSIFICAÇÃO (construção × recorrência × esporádica) ────────────────────
//   1) o lançamento classificado à mão na tela vence sempre
//      (sales_stand_expense_classes)
//   2) senão, herda a categoria da CONTA (sales_stand_expense_categories)
//   3) sem categoria para a conta, fica "sem classificação" — aparece separado
//      na tela em vez de entrar calado em um dos lados
import db from '../../models/sequelize/index.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';
import apiSienge from '../../lib/apiSienge.js';

// Fallbacks de código: valem só enquanto a tela não tiver gravado a config.
const DEFAULT_SOURCE = process.env.SALES_STAND_EXPENSE_SOURCE || 'departamento';
const DEFAULT_DEPARTMENT = Number(process.env.SALES_STAND_DEPARTMENT_ID || 25);
const DEFAULT_CONTA_PREFIX = process.env.SALES_STAND_CONTA_PREFIX || '20207';

export const SOURCES = ['departamento', 'plano', 'ambos'];
export const KINDS = ['construcao', 'recorrencia', 'esporadica'];
export const normKind = (k) => (KINDS.includes(String(k)) ? String(k) : null);

const normIds = (arr) => (Array.isArray(arr) ? [...new Set(arr.map(Number).filter(Boolean))] : []);
const round = (v) => Math.round((Number(v) || 0) * 100) / 100;
const plain = (r) => (r?.get ? r.get({ plain: true }) : r);

function httpError(message, status, code = null) {
    const e = new Error(message);
    e.httpStatus = status;
    if (code) e.code = code;
    return e;
}

// ── Configuração do módulo ───────────────────────────────────────────────────

let _settingsCache = { at: 0, row: null };
const SETTINGS_TTL_MS = 60 * 1000;

export async function getSettings() {
    if (_settingsCache.row && Date.now() - _settingsCache.at < SETTINGS_TTL_MS) {
        return _settingsCache.row;
    }
    const row = await db.SalesStandSetting.findOne({ order: [['id', 'ASC']] });
    const settings = row ? plain(row) : {
        expense_source: DEFAULT_SOURCE,
        department_id: DEFAULT_DEPARTMENT,
        conta_prefix: DEFAULT_CONTA_PREFIX,
    };
    if (!SOURCES.includes(settings.expense_source)) settings.expense_source = DEFAULT_SOURCE;
    _settingsCache = { at: Date.now(), row: settings };
    return settings;
}

export async function updateSettings({ payload = {}, userId }) {
    const row = (await db.SalesStandSetting.findOne({ order: [['id', 'ASC']] }))
        || await db.SalesStandSetting.create({});
    if ('expense_source' in payload) {
        const v = String(payload.expense_source || '');
        if (!SOURCES.includes(v)) throw httpError('Origem do gasto inválida.', 400);
        row.expense_source = v;
    }
    if ('department_id' in payload) {
        const v = Number(payload.department_id);
        if (!Number.isFinite(v) || v <= 0) throw httpError('Departamento inválido.', 400);
        row.department_id = v;
    }
    if ('conta_prefix' in payload) {
        const v = String(payload.conta_prefix || '').replace(/\D/g, '');
        if (!v) throw httpError('Informe o prefixo do plano financeiro (ex.: 20207).', 400);
        row.conta_prefix = v;
    }
    row.updated_by = userId || null;
    await row.save();
    // A régua mudou: todo número em cache virou mentira.
    _settingsCache = { at: 0, row: null };
    clearSpendCache();
    return plain(row);
}

export async function seedSalesStandSettings() {
    const count = await db.SalesStandSetting.count();
    if (count === 0) {
        await db.SalesStandSetting.create({
            expense_source: DEFAULT_SOURCE,
            department_id: DEFAULT_DEPARTMENT,
            conta_prefix: DEFAULT_CONTA_PREFIX,
        });
        console.log(`✅ Stand de Vendas: configuração criada (origem do gasto = ${DEFAULT_SOURCE}).`);
    }
}

/** Departamentos do Sienge, para escolher qual é o do stand na tela. */
export async function listDepartments() {
    const { rows } = await siengeQuery(
        'SELECT cddepartamento AS id, nmdepartamento AS name FROM ecaddepartamento ORDER BY nmdepartamento',
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

// ── Cache dos lançamentos ────────────────────────────────────────────────────

const SPEND_TTL_MS = Number(process.env.SALES_STAND_SPEND_TTL_MS || 5 * 60 * 1000);

let _itemsCache = { at: 0, key: '', rows: null };

export function clearSpendCache() {
    _itemsCache = { at: 0, key: '', rows: null };
    _contasCache = { at: 0, key: '', rows: null };
}

// ── Lançamento a lançamento ──────────────────────────────────────────────────

// Chave estável do lançamento. NÃO leva o mês: a mesma nota paga em dois meses
// é o mesmo item — classificar uma vez vale para os dois.
const expenseKey = (nutitulo, nuparcela, cdconta) => `${nutitulo}-${nuparcela}-${cdconta}`;

/**
 * Lançamentos de stand nos centros de custo informados, um por
 * título/parcela/conta, com a quebra por mês de pagamento em `months`.
 * O recorte (departamento, plano ou os dois) vem da configuração do módulo.
 */
export async function listStandExpenseItems(costCenterIds) {
    const views = normIds(costCenterIds);
    if (!views.length) return [];

    const cfg = await getSettings();
    const usaDepto = cfg.expense_source !== 'plano';
    const usaPlano = cfg.expense_source !== 'departamento';

    const key = [
        views.slice().sort((a, b) => a - b).join(','),
        cfg.expense_source, cfg.department_id, cfg.conta_prefix,
    ].join('|');
    if (_itemsCache.rows && _itemsCache.key === key && Date.now() - _itemsCache.at < SPEND_TTL_MS) {
        return _itemsCache.rows;
    }

    // Filtro do recorte + fator do rateio, montados conforme o modo.
    const filtros = [];
    if (usaDepto) filtros.push('d.nutitulo IS NOT NULL');
    if (usaPlano) filtros.push("TRIM(af.cdconta) LIKE $2 || '%'");
    const where = `WHERE ${filtros.join(' AND ')}`;
    // No modo por departamento o valor entra rateado pela participação DELE no
    // título; no modo por plano, inteiro (o rateio já é o do centro de custo).
    const fatorDepto = usaDepto ? ' * COALESCE(a.dep_pct, 0)' : '';

    const sql = `
        WITH cc AS (
            SELECT cdempreend, cdempreendview
            FROM ecadempreend
            WHERE cdempreendview = ANY($1::int[])
        ),
        dep AS (
            -- Participação do departamento do stand em cada título. LEAST(...,100)
            -- porque apropriação repetida no mesmo departamento somaria > 100%.
            SELECT ad.nutitulo, LEAST(SUM(COALESCE(ad.peapropriado, 100)), 100) / 100.0 AS pct
            FROM ecpgapropdepart ad
            WHERE ad.cddepartamento = $3::int
            GROUP BY ad.nutitulo
        ),
        aprop AS (
            SELECT af.nutitulo, TRIM(af.cdconta) AS cdconta,
                   cc.cdempreendview AS cost_center_id,
                   COALESCE(af.peparticipacao, 100) AS pct,
                   d.pct AS dep_pct,
                   -- Serve para a tela marcar o que veio de fora do plano do
                   -- stand e, de quebra, tipa $2 no modo por departamento (onde
                   -- o LIKE não entra no filtro).
                   (TRIM(af.cdconta) LIKE $2 || '%') AS conta_do_plano
            FROM ecpgapropfin af
            JOIN cc ON cc.cdempreend = af.cdcentrocusto
            LEFT JOIN dep d ON d.nutitulo = af.nutitulo
            ${where}
        ),
        pagamentos AS (
            SELECT b.nutitulo, b.nuparcela,
                   to_char(date_trunc('month', b.dtpagto), 'YYYY-MM') AS ym,
                   MAX(b.dtpagto) AS dtpagto,
                   SUM(b.vlpagto + COALESCE(b.vljuros,0) + COALESCE(b.vlmulta,0)
                       + COALESCE(b.vlcormonetaria,0) - COALESCE(b.vldesconto,0)) AS valor_pago
            FROM ecpgbaixa b
            WHERE b.nutitulo IN (SELECT DISTINCT nutitulo FROM aprop)
              AND b.cdtipobaixa IN (1, 10)
              AND b.nuseqestorno IS NULL
            GROUP BY b.nutitulo, b.nuparcela, date_trunc('month', b.dtpagto)
        )
        SELECT pg.nutitulo, pg.nuparcela, pg.ym,
               to_char(pg.dtpagto, 'YYYY-MM-DD') AS paid_at,
               a.cdconta AS conta_code,
               pf.nmconta AS conta_name,
               bool_or(a.conta_do_plano) AS conta_do_plano,
               a.cost_center_id,
               COALESCE(NULLIF(TRIM(cr.nmfantasia), ''), NULLIF(TRIM(cr.nmcredor), '')) AS credor,
               TRIM(t.cddocumento) AS doc_type,
               TRIM(t.nudocumento) AS doc_number,
               NULLIF(TRIM(t.deobservacao), '') AS notes,
               to_char(t.dtemissao, 'YYYY-MM-DD') AS issued_at,
               SUM(pg.valor_pago * a.pct / 100.0${fatorDepto}) AS amount
        FROM pagamentos pg
        JOIN aprop a ON a.nutitulo = pg.nutitulo
        JOIN ecpgtitulo t ON t.nutitulo = pg.nutitulo
        LEFT JOIN ecadcredor cr ON cr.cdcredor = t.cdcredor
        LEFT JOIN ecadplanofin pf ON TRIM(pf.cdconta) = a.cdconta
        WHERE TRIM(t.cddocumento) NOT IN ('PCT')
        GROUP BY pg.nutitulo, pg.nuparcela, pg.ym, pg.dtpagto, a.cdconta, pf.nmconta,
                 a.cost_center_id, cr.nmfantasia, cr.nmcredor, t.cddocumento,
                 t.nudocumento, t.deobservacao, t.dtemissao
        HAVING SUM(pg.valor_pago * a.pct / 100.0${fatorDepto}) <> 0
        ORDER BY pg.ym DESC, amount DESC
    `;
    const { rows } = await siengeQuery(sql, [views, cfg.conta_prefix, cfg.department_id]);

    // Uma linha por título/parcela/conta; os meses viram a quebra interna.
    const byKey = new Map();
    for (const r of rows) {
        const k = expenseKey(r.nutitulo, r.nuparcela, r.conta_code);
        const amount = Number(r.amount) || 0;
        let item = byKey.get(k);
        if (!item) {
            item = {
                key: k,
                billId: Number(r.nutitulo),
                installment: Number(r.nuparcela),
                contaCode: r.conta_code,
                contaName: r.conta_name || null,
                standPlan: !!r.conta_do_plano,
                costCenterId: Number(r.cost_center_id),
                supplier: r.credor || 'Sem credor identificado',
                docType: r.doc_type || null,
                docNumber: r.doc_number || null,
                notes: r.notes || null,
                issuedAt: r.issued_at || null,
                paidAt: r.paid_at || null,
                amount: 0,
                months: [],
            };
            byKey.set(k, item);
        }
        item.amount += amount;
        item.months.push({ ym: r.ym, amount: round(amount), paidAt: r.paid_at || null });
        // A data do lançamento é a do pagamento mais recente.
        if (!item.paidAt || (r.paid_at && r.paid_at > item.paidAt)) item.paidAt = r.paid_at;
    }

    const result = [...byKey.values()].map((i) => ({
        ...i,
        amount: round(i.amount),
        months: i.months.sort((a, b) => a.ym.localeCompare(b.ym)),
        firstYm: i.months.reduce((m, x) => (!m || x.ym < m ? x.ym : m), null),
        lastYm: i.months.reduce((m, x) => (!m || x.ym > m ? x.ym : m), null),
    })).sort((a, b) => (b.lastYm || '').localeCompare(a.lastYm || '') || b.amount - a.amount);

    _itemsCache = { at: Date.now(), key, rows: result };
    return result;
}

/**
 * Visão agregada (mês × CC × conta) — derivada dos MESMOS lançamentos, para não
 * existir a chance de a soma da tela discordar da lista que a compõe.
 */
export async function listStandSpendRows(costCenterIds) {
    const items = await listStandExpenseItems(costCenterIds);
    const map = new Map();
    for (const item of items) {
        for (const m of item.months) {
            const k = `${m.ym}|${item.costCenterId}|${item.contaCode}`;
            const row = map.get(k) || {
                ym: m.ym,
                costCenterId: item.costCenterId,
                contaCode: item.contaCode,
                contaName: item.contaName,
                amount: 0,
            };
            row.amount += m.amount;
            map.set(k, row);
        }
    }
    return [...map.values()].map((r) => ({ ...r, amount: round(r.amount) }));
}

// Agrega as linhas de um conjunto de CCs em { total, byMonth, byConta, byCostCenter }.
export function aggregateSpend(rows, ccIds) {
    const set = new Set(normIds(ccIds));
    const byMonth = new Map();
    const byConta = new Map();
    const byCc = new Map();
    let total = 0;
    for (const r of rows) {
        if (!set.has(r.costCenterId)) continue;
        total += r.amount;
        byMonth.set(r.ym, (byMonth.get(r.ym) || 0) + r.amount);
        const conta = byConta.get(r.contaCode) || { code: r.contaCode, name: r.contaName, amount: 0 };
        conta.amount += r.amount;
        if (!conta.name && r.contaName) conta.name = r.contaName;
        byConta.set(r.contaCode, conta);
        byCc.set(r.costCenterId, (byCc.get(r.costCenterId) || 0) + r.amount);
    }
    return {
        total: round(total),
        byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            .map(([ym, amount]) => ({ ym, amount: round(amount) })),
        byConta: [...byConta.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)))
            .map((c) => ({ ...c, amount: round(c.amount) })),
        byCostCenter: [...byCc.entries()].map(([costCenterId, amount]) => ({ costCenterId, amount: round(amount) })),
    };
}

// ── Categorias de gasto ──────────────────────────────────────────────────────

export async function listCategories() {
    const rows = await db.SalesStandExpenseCategory.findAll({
        order: [['sort_order', 'ASC'], ['name', 'ASC']],
    });
    return rows.map(plain);
}

const cleanContas = (arr) => (Array.isArray(arr)
    ? [...new Set(arr.map((c) => String(c || '').trim()).filter(Boolean))]
    : []);

// Uma conta só pode ter um dono: se ela já está em outra categoria, sai de lá.
async function releaseContas(contas, exceptId = null) {
    if (!contas.length) return;
    const rows = await db.SalesStandExpenseCategory.findAll();
    for (const row of rows) {
        if (exceptId && row.id === Number(exceptId)) continue;
        const kept = (row.conta_codes || []).filter((c) => !contas.includes(String(c)));
        if (kept.length !== (row.conta_codes || []).length) {
            row.conta_codes = kept;
            await row.save();
        }
    }
}

export async function createCategory({ payload = {}, userId }) {
    const name = (payload.name || '').trim();
    if (!name) throw httpError('Nome da categoria é obrigatório.', 400);
    const kind = normKind(payload.kind);
    if (!kind) throw httpError('Informe se a categoria é construção, recorrência ou esporádica.', 400);
    const contas = cleanContas(payload.conta_codes);
    await releaseContas(contas);
    const row = await db.SalesStandExpenseCategory.create({
        name,
        kind,
        conta_codes: contas,
        description: payload.description?.trim() || null,
        sort_order: Number(payload.sort_order) || 0,
        is_active: payload.is_active !== false,
        created_by: userId || null,
        updated_by: userId || null,
    });
    return plain(row);
}

export async function updateCategory({ id, payload = {}, userId }) {
    const row = await db.SalesStandExpenseCategory.findByPk(Number(id));
    if (!row) throw httpError('Categoria não encontrada.', 404);
    if ('name' in payload) row.name = (payload.name || '').trim() || row.name;
    if ('kind' in payload) {
        const kind = normKind(payload.kind);
        if (!kind) throw httpError('Tipo inválido: use construção, recorrência ou esporádica.', 400);
        row.kind = kind;
    }
    if ('conta_codes' in payload) {
        const contas = cleanContas(payload.conta_codes);
        await releaseContas(contas, row.id);
        row.conta_codes = contas;
    }
    if ('description' in payload) row.description = payload.description?.trim() || null;
    if ('sort_order' in payload) row.sort_order = Number(payload.sort_order) || 0;
    if ('is_active' in payload) row.is_active = !!payload.is_active;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

export async function deleteCategory({ id }) {
    const row = await db.SalesStandExpenseCategory.findByPk(Number(id));
    if (!row) throw httpError('Categoria não encontrada.', 404);
    // Lançamento que apontava para ela volta a herdar da conta.
    await db.SalesStandExpenseClass.update({ category_id: null }, { where: { category_id: row.id } });
    await row.destroy();
    return { ok: true };
}

let _contasCache = { at: 0, key: '', rows: null };

/**
 * Contas para montar as categorias. Traz as do plano do stand E as que
 * REALMENTE aparecem no gasto do recorte de hoje — no modo por departamento
 * entram contas de fora do 2.02.07, e sem elas na lista não haveria como
 * categorizar o que a tela mostra.
 */
export async function listContas() {
    const cfg = await getSettings();
    const key = `${cfg.expense_source}|${cfg.department_id}|${cfg.conta_prefix}`;
    if (_contasCache.rows && _contasCache.key === key && Date.now() - _contasCache.at < SPEND_TTL_MS) {
        return _contasCache.rows;
    }

    const usaDepto = cfg.expense_source !== 'plano';
    const sql = `
        WITH usadas AS (
            SELECT TRIM(af.cdconta) AS code, COUNT(*) AS lancamentos
            FROM ecpgapropfin af
            ${usaDepto ? 'JOIN ecpgapropdepart ad ON ad.nutitulo = af.nutitulo AND ad.cddepartamento = $2::int' : ''}
            ${usaDepto ? '' : "WHERE TRIM(af.cdconta) LIKE $1 || '%'"}
            GROUP BY 1
        )
        SELECT TRIM(pf.cdconta) AS code, pf.nmconta AS name,
               (TRIM(pf.cdconta) LIKE $1 || '%') AS do_plano_stand,
               COALESCE(u.lancamentos, 0) AS lancamentos
        FROM ecadplanofin pf
        LEFT JOIN usadas u ON u.code = TRIM(pf.cdconta)
        WHERE (TRIM(pf.cdconta) LIKE $1 || '%' AND TRIM(pf.cdconta) <> $1)
           OR u.code IS NOT NULL
        ORDER BY (TRIM(pf.cdconta) LIKE $1 || '%') DESC, COALESCE(u.lancamentos, 0) DESC, pf.nmconta
    `;
    const { rows } = await siengeQuery(sql, [cfg.conta_prefix, cfg.department_id]);
    const result = rows.map((r) => ({
        code: r.code,
        name: r.name,
        standPlan: !!r.do_plano_stand,
        entries: Number(r.lancamentos) || 0,
    }));
    _contasCache = { at: Date.now(), key, rows: result };
    return result;
}

// ── Conferência: departamento × plano do stand ────────────────────────
// Depois que a apuração passou a sair do DEPARTAMENTO, a qualidade do número
// depende de quem lança o título marcar o departamento certo. Esta consulta é o
// instrumento para cobrar e para conferir se a correção chegou:
//
//   certo          → no departamento do stand E numa conta do plano do stand
//   sem_conta      → marcado no departamento, mas a conta não é de stand
//                    (ou a conta está errada, ou o departamento foi indevido)
//   sem_departamento → conta de stand, mas ninguém marcou o departamento
//
// Conforme o administrativo acerta, "certo" cresce e os outros dois encolhem.

export async function listDepartmentDivergence(costCenterIds) {
    const views = normIds(costCenterIds);
    if (!views.length) return { totals: {}, rows: [] };
    const cfg = await getSettings();

    const sql = `
        WITH cc AS (
            SELECT cdempreend, cdempreendview, nmempreend
            FROM ecadempreend WHERE cdempreendview = ANY($1::int[])
        ),
        pg AS (
            SELECT b.nutitulo,
                   SUM(b.vlpagto + COALESCE(b.vljuros,0) + COALESCE(b.vlmulta,0)
                       + COALESCE(b.vlcormonetaria,0) - COALESCE(b.vldesconto,0)) AS v
            FROM ecpgbaixa b
            WHERE b.cdtipobaixa IN (1, 10) AND b.nuseqestorno IS NULL
            GROUP BY b.nutitulo
        ),
        dep AS (
            SELECT DISTINCT nutitulo FROM ecpgapropdepart WHERE cddepartamento = $2::int
        ),
        base AS (
            SELECT af.nutitulo,
                   TRIM(af.cdconta) AS conta,
                   (TRIM(af.cdconta) LIKE $3 || '%') AS conta_stand,
                   (d.nutitulo IS NOT NULL) AS no_depto,
                   cc.cdempreendview AS cost_center_id,
                   cc.nmempreend AS cost_center_name,
                   pg.v * COALESCE(af.peparticipacao, 100) / 100.0 AS valor
            FROM ecpgapropfin af
            JOIN cc ON cc.cdempreend = af.cdcentrocusto
            JOIN pg ON pg.nutitulo = af.nutitulo
            JOIN ecpgtitulo t ON t.nutitulo = af.nutitulo
            LEFT JOIN dep d ON d.nutitulo = af.nutitulo
            WHERE TRIM(t.cddocumento) NOT IN ('PCT')
        )
        SELECT CASE WHEN no_depto AND conta_stand THEN 'certo'
                    WHEN no_depto THEN 'sem_conta'
                    ELSE 'sem_departamento' END AS situacao,
               b.cost_center_id, MAX(b.cost_center_name) AS cost_center_name,
               b.conta, MAX(pf.nmconta) AS conta_name,
               COUNT(DISTINCT b.nutitulo) AS titulos,
               ROUND(SUM(b.valor), 2) AS valor
        FROM base b
        LEFT JOIN ecadplanofin pf ON TRIM(pf.cdconta) = b.conta
        WHERE b.no_depto OR b.conta_stand
        GROUP BY 1, 2, 4
        ORDER BY valor DESC
    `;
    const { rows } = await siengeQuery(sql, [views, cfg.department_id, cfg.conta_prefix]);

    const totals = { certo: { titulos: 0, valor: 0 }, sem_conta: { titulos: 0, valor: 0 }, sem_departamento: { titulos: 0, valor: 0 } };
    const out = rows.map((r) => {
        const item = {
            situacao: r.situacao,
            costCenterId: Number(r.cost_center_id),
            costCenterName: r.cost_center_name,
            contaCode: r.conta,
            contaName: r.conta_name || null,
            titulos: Number(r.titulos) || 0,
            valor: round(r.valor),
        };
        totals[item.situacao].titulos += item.titulos;
        totals[item.situacao].valor = round(totals[item.situacao].valor + item.valor);
        return item;
    });
    return { totals, rows: out };
}

/**
 * Os TÍTULOS divergentes, um a um (a consulta acima agrega por conta). Serve
 * para conferir cada um ao vivo na API do Sienge.
 */
export async function listDivergentBills(costCenterIds, { limit = 300, offset = 0 } = {}) {
    const views = normIds(costCenterIds);
    if (!views.length) return { bills: [], total: 0 };
    const cfg = await getSettings();

    const sql = `
        WITH cc AS (
            SELECT cdempreend, cdempreendview FROM ecadempreend WHERE cdempreendview = ANY($1::int[])
        ),
        pg AS (
            SELECT b.nutitulo,
                   SUM(b.vlpagto + COALESCE(b.vljuros,0) + COALESCE(b.vlmulta,0)
                       + COALESCE(b.vlcormonetaria,0) - COALESCE(b.vldesconto,0)) AS v
            FROM ecpgbaixa b
            WHERE b.cdtipobaixa IN (1, 10) AND b.nuseqestorno IS NULL
            GROUP BY b.nutitulo
        ),
        dep AS (SELECT DISTINCT nutitulo FROM ecpgapropdepart WHERE cddepartamento = $2::int),
        base AS (
            SELECT af.nutitulo, TRIM(af.cdconta) AS conta,
                   (TRIM(af.cdconta) LIKE $3 || '%') AS conta_stand,
                   (d.nutitulo IS NOT NULL) AS no_depto,
                   cc.cdempreendview AS cost_center_id,
                   SUM(pg.v * COALESCE(af.peparticipacao, 100) / 100.0) AS valor
            FROM ecpgapropfin af
            JOIN cc ON cc.cdempreend = af.cdcentrocusto
            JOIN pg ON pg.nutitulo = af.nutitulo
            JOIN ecpgtitulo t ON t.nutitulo = af.nutitulo
            LEFT JOIN dep d ON d.nutitulo = af.nutitulo
            WHERE TRIM(t.cddocumento) NOT IN ('PCT')
            GROUP BY af.nutitulo, TRIM(af.cdconta), d.nutitulo, cc.cdempreendview
        )
        SELECT b.nutitulo AS bill_id, b.cost_center_id, b.conta AS conta_code,
               pf.nmconta AS conta_name, ROUND(b.valor, 2) AS valor,
               CASE WHEN b.no_depto THEN 'sem_conta' ELSE 'sem_departamento' END AS situacao,
               TRIM(t.cddocumento) AS doc_type, TRIM(t.nudocumento) AS doc_number,
               (SELECT string_agg(DISTINCT ad.cddepartamento::text, ',')
                  FROM ecpgapropdepart ad WHERE ad.nutitulo = b.nutitulo) AS deptos_espelho
        FROM base b
        JOIN ecpgtitulo t ON t.nutitulo = b.nutitulo
        LEFT JOIN ecadplanofin pf ON TRIM(pf.cdconta) = b.conta
        WHERE (b.no_depto AND NOT b.conta_stand) OR (NOT b.no_depto AND b.conta_stand)
        ORDER BY b.valor DESC
    `;
    const { rows } = await siengeQuery(sql, [views, cfg.department_id, cfg.conta_prefix]);
    const bills = rows.map((r) => ({
        billId: Number(r.bill_id),
        costCenterId: Number(r.cost_center_id),
        contaCode: r.conta_code,
        contaName: r.conta_name || null,
        docType: r.doc_type || null,
        docNumber: r.doc_number || null,
        valor: round(r.valor),
        situacao: r.situacao,
        deptosEspelho: String(r.deptos_espelho || '').split(',').filter(Boolean).map(Number),
    }));
    const ini = Math.max(0, Number(offset) || 0);
    return { bills: bills.slice(ini, ini + limit), total: bills.length, offset: ini };
}

/**
 * Confere na API do Sienge, AO VIVO, em que departamento cada título está agora.
 *
 * Existe porque o espelho é recarregado uma vez por dia: quando o
 * administrativo acerta o departamento hoje, a correção só aparece na tela
 * depois da próxima carga. Isto é a antecipação dessa resposta — uma chamada
 * GET /v1/bills/{id}/departments-cost por título, nada é escrito no ERP.
 */
// A API do Sienge devolve 429 com Retry-After quando passa de ~100 chamadas por
// minuto (medido em 27/08/2026: 260 chamadas em rajada = 96 OK e 164 recusadas,
// Retry-After: 1). Sem tratar isso, a conferência "falhava" em massa e parecia
// erro de dado, quando era só pressa.
async function apiGetComEspera(url, tentativas = 5) {
    for (let i = 0; ; i += 1) {
        try {
            return await apiSienge.get(url);
        } catch (e) {
            const status = e?.response?.status;
            if (status !== 429 || i >= tentativas) throw e;
            const retryAfter = Number(e.response?.headers?.['retry-after']) || 1;
            await new Promise((r) => setTimeout(r, retryAfter * 1000 * (i + 1)));
        }
    }
}

/**
 * Confere na API do Sienge, AO VIVO, em que departamento (e em que conta) cada
 * título está agora.
 *
 * Existe porque o espelho é recarregado uma vez por dia: quando o
 * administrativo acerta o departamento hoje, a correção só apareceria na tela
 * depois da próxima carga. Isto antecipa a resposta. Só LEITURA - nada é
 * escrito no ERP.
 *
 * Duas fases para gastar menos chamada: todo mundo tem o departamento
 * consultado; a conta só é consultada para quem continua pendente e cuja
 * correção poderia ter vindo por troca de conta.
 */
export async function checkBillsDepartmentLive(bills, { concurrency = 4 } = {}) {
    const cfg = await getSettings();
    const alvo = Number(cfg.department_id);
    const prefixo = String(cfg.conta_prefix);
    // Chave por título + CONTA: o mesmo título pode ter duas linhas divergentes
    // (contas diferentes), e chavear só pelo título comia uma delas do relatório.
    const chave = (b) => `${b.billId}-${b.contaCode}`;
    const resultados = new Map();

    async function rodar(lista, tarefa) {
        const fila = [...lista];
        await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
            for (;;) {
                const item = fila.shift();
                if (!item) return;
                await tarefa(item);
            }
        }));
    }

    // Fase 1: o departamento de cada título.
    await rodar(bills, async (b) => {
        try {
            const { data } = await apiGetComEspera(`/v1/bills/${b.billId}/departments-cost`);
            const live = (data?.results || []).map((x) => ({
                departmentId: Number(x.departmentId),
                departmentName: x.departmentName || null,
                percentage: Number(x.percentage),
            }));
            const temDepto = live.some((x) => x.departmentId === alvo);
            resultados.set(chave(b), {
                ...b,
                live,
                liveDepartments: live.map((x) => x.departmentId),
                liveDepartmentNames: live.map((x) => x.departmentName).filter(Boolean),
                liveContas: null,
                hasStandDepartment: temDepto,
                hasStandConta: null,
                resolved: b.situacao === 'sem_departamento' ? temDepto : !temDepto,
                error: null,
            });
        } catch (e) {
            resultados.set(chave(b), {
                ...b,
                live: [],
                liveDepartments: [],
                liveDepartmentNames: [],
                liveContas: null,
                hasStandDepartment: null,
                hasStandConta: null,
                resolved: null,
                error: e?.response?.status ? `HTTP ${e.response.status}` : (e.message || 'falha'),
            });
        }
    });

    // Fase 2: a conta, só para o que continua pendente por estar no departamento
    // com conta de fora - aí a correção pode ter sido trocar a conta.
    const paraConta = [...resultados.values()]
        .filter((r) => r.situacao === 'sem_conta' && r.resolved === false && !r.error);
    await rodar(paraConta, async (r) => {
        try {
            const { data } = await apiGetComEspera(`/v1/bills/${r.billId}/budget-categories`);
            const contas = [...new Set((data?.results || [])
                .map((x) => String(x.paymentCategoriesId || '').trim()).filter(Boolean))];
            const temContaStand = contas.some((c) => c.startsWith(prefixo));
            // A linha problemática é (título + AQUELA conta) dentro do departamento
            // do stand. Só está resolvida quando aquela conta específica saiu do
            // título. O título ter OUTRAS contas de stand não conserta esta linha —
            // dar por resolvida aí seria mascarar o problema.
            resultados.set(chave(r), {
                ...r,
                liveContas: contas,
                hasStandConta: temContaStand,
                resolved: !contas.includes(String(r.contaCode)),
            });
        } catch (e) {
            resultados.set(chave(r), {
                ...r,
                error: e?.response?.status ? `HTTP ${e.response.status}` : (e.message || 'falha'),
                resolved: null,
            });
        }
    });

    return [...resultados.values()].sort((a, b) => b.valor - a.valor);
}

/**
 * Até quando o espelho do Sienge está em dia. O backup é restaurado uma vez por
 * dia: correção feita hoje no Sienge só aparece aqui depois da próxima carga,
 * e a tela precisa dizer isso em vez de deixar todo mundo achando que o número
 * é de agora.
 */
export async function getDataFreshness() {
    const { rows } = await siengeQuery(`
        SELECT to_char(MAX(GREATEST(dtcadastro, COALESCE(dtalteracao, dtcadastro))), 'YYYY-MM-DD"T"HH24:MI:SS') AS last_change
        FROM ecpgtitulo
    `);
    return { lastChange: rows?.[0]?.last_change || null };
}

// ── Classificação ────────────────────────────────────────────────────────────

/**
 * Devolve os itens com kind/categoria resolvidos.
 * source: 'manual' (classificado na tela) | 'categoria' (herdou da conta) | null
 */
export function applyClassification(items, categories, overrides) {
    const catById = new Map(categories.map((c) => [Number(c.id), c]));
    const catByConta = new Map();
    for (const c of categories) {
        if (c.is_active === false) continue;
        for (const code of c.conta_codes || []) catByConta.set(String(code), c);
    }
    const overrideByKey = new Map(overrides.map((o) => [o.expense_key, o]));

    return items.map((item) => {
        const ov = overrideByKey.get(item.key);
        const inherited = catByConta.get(String(item.contaCode)) || null;
        const cat = ov?.category_id ? catById.get(Number(ov.category_id)) || null : inherited;
        const kind = normKind(ov?.kind) || (cat ? cat.kind : null);
        return {
            ...item,
            kind,
            source: ov ? 'manual' : (kind ? 'categoria' : null),
            categoryId: cat ? cat.id : null,
            categoryName: cat ? cat.name : null,
        };
    });
}

/** Totais por tipo, por mês, por categoria e por conta a partir dos itens já classificados. */
export function summarize(items) {
    const totals = { construcao: 0, recorrencia: 0, esporadica: 0, sem_classificacao: 0, total: 0 };
    const byMonth = new Map();
    const byCategory = new Map();
    const byConta = new Map();

    for (const item of items) {
        const bucket = item.kind || 'sem_classificacao';
        totals[bucket] += item.amount;
        totals.total += item.amount;

        for (const m of item.months) {
            const row = byMonth.get(m.ym) || { ym: m.ym, construcao: 0, recorrencia: 0, esporadica: 0, sem_classificacao: 0, total: 0 };
            row[bucket] += m.amount;
            row.total += m.amount;
            byMonth.set(m.ym, row);
        }

        const catKey = item.categoryId || `conta:${item.contaCode}`;
        const cat = byCategory.get(catKey) || {
            id: item.categoryId || null,
            name: item.categoryName || `Sem categoria (${item.contaName || item.contaCode})`,
            kind: item.kind || null,
            amount: 0,
            items: 0,
        };
        cat.amount += item.amount;
        cat.items += 1;
        byCategory.set(catKey, cat);

        const conta = byConta.get(item.contaCode) || {
            code: item.contaCode, name: item.contaName, amount: 0, items: 0,
        };
        conta.amount += item.amount;
        conta.items += 1;
        byConta.set(item.contaCode, conta);
    }

    const fix = (o, keys) => { for (const k of keys) o[k] = round(o[k]); return o; };
    return {
        totals: fix(totals, ['construcao', 'recorrencia', 'esporadica', 'sem_classificacao', 'total']),
        byMonth: [...byMonth.values()]
            .sort((a, b) => a.ym.localeCompare(b.ym))
            .map((m) => fix(m, ['construcao', 'recorrencia', 'esporadica', 'sem_classificacao', 'total'])),
        byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount).map((c) => fix(c, ['amount'])),
        byConta: [...byConta.values()].sort((a, b) => String(a.code).localeCompare(String(b.code))).map((c) => fix(c, ['amount'])),
    };
}

// ── Padrões recorrentes ──────────────────────────────────────────────────────

const MIN_PATTERN_MONTHS = Number(process.env.SALES_STAND_PATTERN_MIN_MONTHS || 3);

const normSupplier = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Acha o que se repete: mesmo credor + mesma conta pagando em vários meses.
 * É o que separa "montei o stand" de "manter o stand custa X por mês" sem
 * depender de ninguém marcar nada — a tela usa isso para sugerir a
 * classificação em lote e para projetar o custo mensal.
 */
export function detectPatterns(items) {
    const groups = new Map();
    let maxYm = '';

    for (const item of items) {
        const gk = `${normSupplier(item.supplier)}|${item.contaCode}`;
        const g = groups.get(gk) || {
            id: gk,
            supplier: item.supplier,
            contaCode: item.contaCode,
            contaName: item.contaName,
            months: new Map(),
            itemKeys: [],
            total: 0,
            kinds: new Set(),
        };
        g.itemKeys.push(item.key);
        g.total += item.amount;
        if (item.kind) g.kinds.add(item.kind);
        for (const m of item.months) {
            g.months.set(m.ym, round((g.months.get(m.ym) || 0) + m.amount));
            if (m.ym > maxYm) maxYm = m.ym;
        }
        groups.set(gk, g);
    }

    // "Ativo" = pagou no mês mais recente da base ou no anterior.
    const prevYm = (ym) => {
        if (!ym) return '';
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 2, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    const recentes = new Set([maxYm, prevYm(maxYm)]);

    return [...groups.values()]
        .map((g) => {
            const months = [...g.months.entries()].sort((a, b) => a[0].localeCompare(b[0]))
                .map(([ym, amount]) => ({ ym, amount }));
            const lastYm = months.length ? months[months.length - 1].ym : null;
            const values = months.map((m) => m.amount);
            const avg = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
            return {
                id: g.id,
                supplier: g.supplier,
                contaCode: g.contaCode,
                contaName: g.contaName,
                itemKeys: g.itemKeys,
                monthsCount: months.length,
                months,
                firstYm: months.length ? months[0].ym : null,
                lastYm,
                total: round(g.total),
                avgMonth: round(avg),
                active: !!lastYm && recentes.has(lastYm),
                // Já classificado por inteiro de um jeito só? Então não há o que sugerir.
                currentKind: g.kinds.size === 1 ? [...g.kinds][0] : null,
                suggestedKind: 'recorrencia',
            };
        })
        .filter((p) => p.monthsCount >= MIN_PATTERN_MONTHS)
        .sort((a, b) => Number(b.active) - Number(a.active) || b.avgMonth - a.avgMonth);
}

// ── Seed das categorias padrão ───────────────────────────────────────────────
// Espelham as 13 contas filhas do 2.02.07. Construção = o que fica no stand
// depois de pronto; recorrência = o que volta todo mês enquanto ele está de pé;
// esporádica = o que acontece de vez em quando e não dá para contar como mensal.
// Isto é só o PONTO DE PARTIDA: o tipo de cada categoria se edita na tela.

const DEFAULT_CATEGORIES = [
    { name: 'Decorado', kind: 'construcao', conta_codes: ['2020702'], sort_order: 10, description: 'Casa/apartamento decorado do stand.' },
    { name: 'Móveis e decoração', kind: 'construcao', conta_codes: ['2020701'], sort_order: 20, description: 'Eletroeletrônicos, mobiliário e decoração.' },
    { name: 'Obra e empreiteiros', kind: 'construcao', conta_codes: ['2020703'], sort_order: 30, description: 'Serviços terceirizados e empreiteiros da montagem.' },
    { name: 'Comunicação visual', kind: 'construcao', conta_codes: ['2020710'], sort_order: 40, description: 'Impressos, plotagens e encadernação.' },
    { name: 'Fretes e transportes', kind: 'construcao', conta_codes: ['2020712'], sort_order: 50, description: 'Fretes e entregas da montagem do stand.' },
    { name: 'Aluguel', kind: 'recorrencia', conta_codes: ['2020704'], sort_order: 60, description: 'Aluguel do imóvel ou do terreno do stand.' },
    { name: 'Energia elétrica', kind: 'recorrencia', conta_codes: ['2020706'], sort_order: 70 },
    { name: 'Água e esgoto', kind: 'recorrencia', conta_codes: ['2020705'], sort_order: 80 },
    { name: 'Telefone e internet', kind: 'recorrencia', conta_codes: ['2020707'], sort_order: 90 },
    { name: 'Consumo e limpeza', kind: 'recorrencia', conta_codes: ['2020708'], sort_order: 100, description: 'Consumo, conservação e limpeza.' },
    { name: 'Manutenção e melhorias', kind: 'recorrencia', conta_codes: ['2020709'], sort_order: 110, description: 'Manutenção, reforma e melhorias depois do stand pronto.' },
    { name: 'Locação de equipamentos', kind: 'recorrencia', conta_codes: ['2020711', '2020713'], sort_order: 120, description: 'Impressoras, máquinas e equipamentos alugados.' },
];

export async function seedSalesStandExpenseCategories() {
    const count = await db.SalesStandExpenseCategory.count();
    if (count === 0) {
        await db.SalesStandExpenseCategory.bulkCreate(DEFAULT_CATEGORIES);
        console.log(`✅ Stand de Vendas: ${DEFAULT_CATEGORIES.length} categorias de gasto padrão criadas.`);
        return;
    }
    // Já populada: só repõe a descrição/ordem das que ninguém editou na tela
    // (updated_by null). Categoria editada ou excluída fica intocada.
    for (const def of DEFAULT_CATEGORIES) {
        const row = await db.SalesStandExpenseCategory.findOne({ where: { name: def.name, updated_by: null } });
        if (!row) continue;
        row.kind = def.kind;
        row.conta_codes = def.conta_codes;
        row.description = def.description || null;
        row.sort_order = def.sort_order;
        await row.save();
    }
}

export default {
    SOURCES,
    getSettings,
    updateSettings,
    seedSalesStandSettings,
    listDepartments,
    listStandSpendRows,
    listStandExpenseItems,
    aggregateSpend,
    applyClassification,
    summarize,
    detectPatterns,
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    listContas,
    listDepartmentDivergence,
    listDivergentBills,
    checkBillsDepartmentLive,
    getDataFreshness,
    clearSpendCache,
    seedSalesStandExpenseCategories,
};
