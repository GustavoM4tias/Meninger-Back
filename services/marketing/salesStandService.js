// services/marketing/salesStandService.js
// Stand de Vendas: stands modelo (categorias com valor médio + itens) e stands
// reais vinculados a 1+ centros de custo do Sienge. O custo realizado vem AO
// VIVO do backup do Sienge (mesma régua de caixa do payableLiveService), mas
// cortado pelo plano financeiro 20207* — "DESPESAS COM STAND" e filhas.
// Ao definir um stand, o total apurado vira snapshot de construção; o gasto
// posterior é recorrente (manutenção — fase futura: % lançado como marketing).
import db from '../../models/sequelize/index.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';
import { listCostCenters } from './marketingApprovalService.js';

const plain = (r) => (r?.get ? r.get({ plain: true }) : r);
const normIds = (arr) => (Array.isArray(arr) ? [...new Set(arr.map(Number).filter(Boolean))] : []);

function httpError(message, status, code = null) {
    const e = new Error(message);
    e.httpStatus = status;
    if (code) e.code = code;
    return e;
}

// Plano financeiro raiz do stand no Sienge (2.02.07 — DESPESAS COM STAND).
const STAND_CONTA_PREFIX = process.env.SALES_STAND_CONTA_PREFIX || '20207';

export { listCostCenters };

// ── Gasto ao vivo no Sienge (cache TTL em memória) ────────────────────────────

const SPEND_TTL_MS = Number(process.env.SALES_STAND_SPEND_TTL_MS || 5 * 60 * 1000);
let _spendCache = { at: 0, key: '', rows: null };

// Linhas { ym, costCenterId, contaCode, contaName, amount } com rateio
// proporcional: peparticipacao da apropriação financeira aplicada sobre o
// líquido desembolsado (baixas de caixa 1/10, sem estorno, mesma régua do
// payableLiveService; documento PCT bloqueado).
export async function listStandSpendRows(costCenterIds) {
    const views = normIds(costCenterIds);
    if (!views.length) return [];
    const key = views.slice().sort((a, b) => a - b).join(',');
    if (_spendCache.rows && _spendCache.key === key && Date.now() - _spendCache.at < SPEND_TTL_MS) {
        return _spendCache.rows;
    }
    const sql = `
        WITH cc AS (
            SELECT cdempreend, cdempreendview
            FROM ecadempreend
            WHERE cdempreendview = ANY($1::int[])
        ),
        aprop AS (
            SELECT af.nutitulo, TRIM(af.cdconta) AS cdconta,
                   cc.cdempreendview AS cost_center_id,
                   COALESCE(af.peparticipacao, 100) AS pct
            FROM ecpgapropfin af
            JOIN cc ON cc.cdempreend = af.cdcentrocusto
            WHERE TRIM(af.cdconta) LIKE $2 || '%'
        ),
        pagamentos AS (
            SELECT b.nutitulo,
                   to_char(date_trunc('month', b.dtpagto), 'YYYY-MM') AS ym,
                   SUM(b.vlpagto + COALESCE(b.vljuros,0) + COALESCE(b.vlmulta,0)
                       + COALESCE(b.vlcormonetaria,0) - COALESCE(b.vldesconto,0)) AS valor_pago
            FROM ecpgbaixa b
            WHERE b.nutitulo IN (SELECT DISTINCT nutitulo FROM aprop)
              AND b.cdtipobaixa IN (1, 10)
              AND b.nuseqestorno IS NULL
            GROUP BY b.nutitulo, date_trunc('month', b.dtpagto)
        )
        SELECT pg.ym,
               a.cost_center_id,
               a.cdconta AS conta_code,
               MAX(pf.nmconta) AS conta_name,
               SUM(pg.valor_pago * a.pct / 100.0) AS amount
        FROM pagamentos pg
        JOIN aprop a ON a.nutitulo = pg.nutitulo
        JOIN ecpgtitulo t ON t.nutitulo = pg.nutitulo
        LEFT JOIN ecadplanofin pf ON TRIM(pf.cdconta) = a.cdconta
        WHERE TRIM(t.cddocumento) NOT IN ('PCT')
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
    `;
    const { rows } = await siengeQuery(sql, [views, STAND_CONTA_PREFIX]);
    const result = rows.map((r) => ({
        ym: r.ym,
        costCenterId: Number(r.cost_center_id),
        contaCode: r.conta_code,
        contaName: r.conta_name || null,
        amount: Number(r.amount) || 0,
    }));
    _spendCache = { at: Date.now(), key, rows: result };
    return result;
}

export function clearSpendCache() {
    _spendCache = { at: 0, key: '', rows: null };
}

// Agrega as linhas de um conjunto de CCs em { total, byMonth, byConta, byCostCenter }.
function aggregateSpend(rows, ccIds) {
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
    const round = (v) => Math.round(v * 100) / 100;
    return {
        total: round(total),
        byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            .map(([ym, amount]) => ({ ym, amount: round(amount) })),
        byConta: [...byConta.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)))
            .map((c) => ({ ...c, amount: round(c.amount) })),
        byCostCenter: [...byCc.entries()].map(([costCenterId, amount]) => ({ costCenterId, amount: round(amount) })),
    };
}

// ── Stands modelo (categorias) ────────────────────────────────────────────────

const cleanItems = (items) => (Array.isArray(items)
    ? items.map((i) => String(i || '').trim()).filter(Boolean)
    : []);

export async function listModels() {
    const rows = await db.SalesStandModel.findAll({ order: [['name', 'ASC']] });
    const counts = await db.SalesStand.count({ where: { is_active: true }, group: ['model_id'] });
    const countByModel = new Map(counts.map((c) => [Number(c.model_id), Number(c.count)]));
    return rows.map((r) => ({ ...plain(r), stands_count: countByModel.get(r.id) || 0 }));
}

export async function createModel({ payload = {}, userId }) {
    const name = (payload.name || '').trim();
    if (!name) throw httpError('Nome do modelo é obrigatório.', 400);
    const min = Number(payload.avg_value_min) || 0;
    const max = Number(payload.avg_value_max) || 0;
    if (max && min > max) throw httpError('O valor "de" não pode ser maior que o valor "até".', 400);
    const row = await db.SalesStandModel.create({
        name,
        description: payload.description?.trim() || null,
        avg_value_min: min,
        avg_value_max: max,
        avg_area_m2: Number(payload.avg_area_m2) || 0,
        items: cleanItems(payload.items),
        is_active: payload.is_active !== false,
        created_by: userId || null,
        updated_by: userId || null,
    });
    return plain(row);
}

export async function updateModel({ id, payload = {}, userId }) {
    const row = await db.SalesStandModel.findByPk(Number(id));
    if (!row) throw httpError('Modelo não encontrado.', 404);
    if ('name' in payload) row.name = (payload.name || '').trim() || row.name;
    if ('description' in payload) row.description = payload.description?.trim() || null;
    if ('avg_value_min' in payload) row.avg_value_min = Number(payload.avg_value_min) || 0;
    if ('avg_value_max' in payload) row.avg_value_max = Number(payload.avg_value_max) || 0;
    if ('avg_area_m2' in payload) row.avg_area_m2 = Number(payload.avg_area_m2) || 0;
    if (Number(row.avg_value_max) && Number(row.avg_value_min) > Number(row.avg_value_max)) {
        throw httpError('O valor "de" não pode ser maior que o valor "até".', 400);
    }
    if ('items' in payload) row.items = cleanItems(payload.items);
    if ('is_active' in payload) row.is_active = !!payload.is_active;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

export async function deleteModel({ id }) {
    const row = await db.SalesStandModel.findByPk(Number(id));
    if (!row) throw httpError('Modelo não encontrado.', 404);
    const inUse = await db.SalesStand.count({ where: { model_id: row.id } });
    if (inUse > 0) throw httpError('Este modelo está em uso por stands cadastrados. Reatribua-os antes de excluir.', 409, 'MODEL_IN_USE');
    await row.destroy();
    return { ok: true };
}

// ── Stands reais ──────────────────────────────────────────────────────────────

async function ccNameMap() {
    const { items } = await listCostCenters();
    return new Map((items || []).map((c) => [Number(c.code), c.name]));
}

// Lista stands com o gasto ao vivo agregado. Sienge fora do ar não derruba a
// tela: devolve spend zerado com spend_unavailable = true.
export async function listStands() {
    const rows = await db.SalesStand.findAll({
        where: { is_active: true },
        include: [{ model: db.SalesStandModel, as: 'model', attributes: ['id', 'name', 'avg_value_min', 'avg_value_max', 'avg_area_m2', 'items'] }],
        order: [['name', 'ASC']],
    });
    const stands = rows.map(plain);
    const allCcIds = normIds(stands.flatMap((s) => s.cost_center_ids || []));

    let spendRows = [];
    let unavailable = false;
    let names = new Map();
    try {
        [spendRows, names] = await Promise.all([listStandSpendRows(allCcIds), ccNameMap()]);
    } catch (err) {
        console.warn('[salesStand.listStands] Sienge indisponível:', err?.message || err);
        unavailable = true;
    }

    return {
        spend_unavailable: unavailable || undefined,
        items: stands.map((s) => {
            const spend = aggregateSpend(spendRows, s.cost_center_ids);
            const construction = s.status === 'defined' ? Number(s.construction_value) || 0 : null;
            return {
                ...s,
                cost_center_names: (s.cost_center_ids || []).map((id) => names.get(Number(id)) || `CC ${id}`),
                spend_total: spend.total,
                // Recorrente após a definição = manutenção (nunca negativo).
                maintenance_value: construction !== null ? Math.max(0, Math.round((spend.total - construction) * 100) / 100) : null,
            };
        }),
    };
}

// Detalhe do gasto de um stand (modal): por mês, por conta e por CC.
export async function getStandSpend({ id }) {
    const row = await db.SalesStand.findByPk(Number(id));
    if (!row) throw httpError('Stand não encontrado.', 404);
    const stand = plain(row);
    const [rows, names] = await Promise.all([
        listStandSpendRows(stand.cost_center_ids),
        ccNameMap().catch(() => new Map()),
    ]);
    const spend = aggregateSpend(rows, stand.cost_center_ids);
    return {
        ...spend,
        byCostCenter: spend.byCostCenter.map((c) => ({
            ...c,
            name: names.get(Number(c.costCenterId)) || `CC ${c.costCenterId}`,
        })),
    };
}

function validateStandPayload(payload) {
    const name = (payload.name || '').trim();
    if (!name) throw httpError('Nome do stand é obrigatório.', 400);
    const ccIds = normIds(payload.cost_center_ids);
    if (!ccIds.length) throw httpError('Vincule ao menos um centro de custo.', 400);
    return { name, ccIds };
}

export async function createStand({ payload = {}, userId }) {
    const { name, ccIds } = validateStandPayload(payload);
    if (payload.model_id) {
        const model = await db.SalesStandModel.findByPk(Number(payload.model_id));
        if (!model) throw httpError('Modelo informado não existe.', 400);
    }
    const row = await db.SalesStand.create({
        name,
        model_id: payload.model_id ? Number(payload.model_id) : null,
        cost_center_ids: ccIds,
        notes: payload.notes?.trim() || null,
        created_by: userId || null,
        updated_by: userId || null,
    });
    return plain(row);
}

export async function updateStand({ id, payload = {}, userId }) {
    const row = await db.SalesStand.findByPk(Number(id));
    if (!row) throw httpError('Stand não encontrado.', 404);
    if ('name' in payload) row.name = (payload.name || '').trim() || row.name;
    if ('model_id' in payload) {
        if (payload.model_id) {
            const model = await db.SalesStandModel.findByPk(Number(payload.model_id));
            if (!model) throw httpError('Modelo informado não existe.', 400);
            row.model_id = Number(payload.model_id);
        } else {
            row.model_id = null;
        }
    }
    if ('cost_center_ids' in payload) {
        const ccIds = normIds(payload.cost_center_ids);
        if (!ccIds.length) throw httpError('Vincule ao menos um centro de custo.', 400);
        row.cost_center_ids = ccIds;
    }
    if ('notes' in payload) row.notes = payload.notes?.trim() || null;
    if ('maintenance_percent' in payload) {
        row.maintenance_percent = payload.maintenance_percent === null || payload.maintenance_percent === ''
            ? null : Number(payload.maintenance_percent);
    }
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

export async function deleteStand({ id }) {
    const row = await db.SalesStand.findByPk(Number(id));
    if (!row) throw httpError('Stand não encontrado.', 404);
    // Soft delete — preserva o histórico de definição.
    row.is_active = false;
    await row.save();
    return { ok: true };
}

// Define o stand: congela o custo de construção (soma atual do 20207* nos CCs
// vinculados, ou valor manual informado). O que entrar depois é manutenção.
export async function defineStand({ id, payload = {}, userId }) {
    const row = await db.SalesStand.findByPk(Number(id));
    if (!row) throw httpError('Stand não encontrado.', 404);
    if (row.status === 'defined') throw httpError('Este stand já está definido.', 409, 'ALREADY_DEFINED');

    let construction = null;
    if (payload.construction_value !== undefined && payload.construction_value !== null && payload.construction_value !== '') {
        construction = Number(payload.construction_value);
        if (!Number.isFinite(construction) || construction < 0) {
            throw httpError('Valor de construção inválido.', 400);
        }
    } else {
        const rows = await listStandSpendRows(row.cost_center_ids);
        construction = aggregateSpend(rows, row.cost_center_ids).total;
    }

    row.status = 'defined';
    row.defined_at = new Date();
    row.construction_value = construction;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

// Reabre o stand (volta a rascunho e limpa o snapshot).
export async function undefineStand({ id, userId }) {
    const row = await db.SalesStand.findByPk(Number(id));
    if (!row) throw httpError('Stand não encontrado.', 404);
    if (row.status !== 'defined') throw httpError('Este stand não está definido.', 409);
    row.status = 'draft';
    row.defined_at = null;
    row.construction_value = null;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

// ── Seed dos 4 modelos padrão (Standard/Medium/Plus/Premium) ─────────────────
// Idempotente: só roda com a tabela vazia, p/ não recriar modelo editado ou
// excluído pelo usuário. Faixa de valor fica 0 (preenchida pela tela).

const DEFAULT_MODELS = [
    {
        name: 'Stand Standard',
        description: 'Praticidade e custo-benefício para lançamentos de entrada: ambiente funcional, direto ao ponto, otimizado para o primeiro contato com o cliente e a captação eficiente de leads.',
        avg_area_m2: 60,
        items: [
            'Ar-condicionado',
            'Recepção com balcão de atendimento',
            'Mesas de atendimento (2)',
            'TV para apresentação do empreendimento',
            'Impressora multifuncional',
            'Máquina de café e água',
            'Banheiro',
            'Fachada com identidade visual',
            'Wi-Fi para a equipe',
        ],
    },
    {
        name: 'Stand Medium',
        description: 'Equilíbrio e versatilidade para empreendimentos de médio padrão: espaço confortável que valoriza a marca, facilita a apresentação de maquetes e a simulação de condições de compra.',
        avg_area_m2: 100,
        items: [
            'Ar-condicionado',
            'Recepção com balcão de atendimento',
            'Mesas de atendimento (4)',
            'Sala de reunião (1)',
            'Maquete do empreendimento',
            'TV / painel de apresentação',
            'Ambiente instagramável',
            'Impressora multifuncional',
            'Máquina de café e água',
            'Copa de apoio',
            'Banheiros (2)',
            'Fachada com identidade visual',
            'Wi-Fi para clientes e equipe',
        ],
    },
    {
        name: 'Stand Plus',
        description: 'Sofisticação e conforto para projetos de alto padrão: atmosfera refinada, materiais de melhor acabamento, iluminação planejada e salas de atendimento privativas que transmitem maior valor agregado.',
        avg_area_m2: 160,
        items: [
            'Ar-condicionado central',
            'Recepção com lounge de espera',
            'Mesas de atendimento (4)',
            'Salas de reunião privativas (2)',
            'Apartamento decorado',
            'Maquete do empreendimento',
            'Painel de LED',
            'Ambiente instagramável',
            'Iluminação planejada',
            'Café gourmet e água',
            'Impressora multifuncional',
            'Espaço kids',
            'Copa de apoio',
            'Banheiros (2)',
            'Paisagismo na entrada',
            'Wi-Fi para clientes e equipe',
        ],
    },
    {
        name: 'Stand Premium',
        description: 'O ápice do mercado de luxo e grandes lançamentos: galeria imersiva e imponente, com arquitetura marcante, elegância e uma experiência sensorial completa para o comprador.',
        avg_area_m2: 250,
        items: [
            'Ar-condicionado central',
            'Galeria imersiva de vendas',
            'Recepção com lounge e bar de café gourmet',
            'Salas de reunião privativas (3)',
            'Decorado completo mobiliado',
            'Maquete interativa',
            'Painéis de LED e projeção',
            'Ambiente instagramável',
            'Experiência sensorial (som e aromatização)',
            'Iluminação cênica planejada',
            'Espaço kids',
            'Impressora multifuncional',
            'Copa completa',
            'Banheiros (3)',
            'Paisagismo e fachada arquitetônica',
            'Estacionamento para clientes',
            'Wi-Fi para clientes e equipe',
        ],
    },
];

export async function seedSalesStandModels() {
    const count = await db.SalesStandModel.count();
    if (count > 0) return;
    await db.SalesStandModel.bulkCreate(DEFAULT_MODELS);
    console.log('✅ Stand de Vendas: 4 modelos padrão criados (Standard/Medium/Plus/Premium).');
}

export default {
    listCostCenters,
    listModels,
    createModel,
    updateModel,
    deleteModel,
    listStands,
    getStandSpend,
    createStand,
    updateStand,
    deleteStand,
    defineStand,
    undefineStand,
    clearSpendCache,
    seedSalesStandModels,
};
