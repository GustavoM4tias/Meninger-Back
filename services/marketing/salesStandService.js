// services/marketing/salesStandService.js
// Stand de Vendas: stands modelo (categorias com valor médio + itens) e stands
// reais vinculados a 1+ centros de custo do Sienge. O custo realizado vem AO
// VIVO do backup do Sienge (mesma régua de caixa do payableLiveService), mas
// cortado pelo plano financeiro 20207* — "DESPESAS COM STAND" e filhas.
// Cada lançamento do Sienge é CONSTRUÇÃO ou RECORRÊNCIA: por padrão ele herda
// isso da categoria da conta, e a tela reclassifica lançamento a lançamento.
// Definir o stand congela como custo de construção o que está classificado
// assim — não existe valor digitado à mão.
// Quem enxerga o stand é quem tem grant do empreendimento (accessScopeService).
import db from '../../models/sequelize/index.js';
import { listCostCenters, listCostCentersForUser } from './costCenterOptions.js';
import {
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
    normKind,
    clearSpendCache,
    getSettings,
    updateSettings,
    listDepartments,
    listDepartmentDivergence,
    listDivergentBills,
    checkBillsDepartmentLive,
    getDataFreshness,
    seedSalesStandExpenseCategories,
    seedSalesStandSettings,
} from './salesStandExpenseService.js';
import { getScope, isErpAllowed } from '../permissions/accessScopeService.js';
import supabase from '../../config/supabaseClient.js';

const plain = (r) => (r?.get ? r.get({ plain: true }) : r);
const normIds = (arr) => (Array.isArray(arr) ? [...new Set(arr.map(Number).filter(Boolean))] : []);

function httpError(message, status, code = null) {
    const e = new Error(message);
    e.httpStatus = status;
    if (code) e.code = code;
    return e;
}

// Todo o gasto (leitura do Sienge, classificação e padrões) mora no
// salesStandExpenseService; aqui fica o cadastro do stand em si.
export {
    listStandSpendRows,
    listStandExpenseItems,
    clearSpendCache,
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    listContas,
    getSettings,
    updateSettings,
    listDepartments,
    getDataFreshness,
    seedSalesStandExpenseCategories,
    seedSalesStandSettings,
};

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
        avg_area_min: Number(payload.avg_area_min) || 0,
        avg_area_max: Number(payload.avg_area_max) || 0,
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
    if ('avg_area_min' in payload) row.avg_area_min = Number(payload.avg_area_min) || 0;
    if ('avg_area_max' in payload) row.avg_area_max = Number(payload.avg_area_max) || 0;
    if (Number(row.avg_area_max) && Number(row.avg_area_min) > Number(row.avg_area_max)) {
        throw httpError('A metragem "de" não pode ser maior que a metragem "até".', 400);
    }
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

const MODEL_ATTRS = ['id', 'name', 'description', 'avg_value_min', 'avg_value_max', 'avg_area_min', 'avg_area_max', 'items'];
const withModel = () => [{ model: db.SalesStandModel, as: 'model', attributes: MODEL_ATTRS }];

// ── Escopo de visualização ──────────────────────────────────────
// TUDO OU NADA: o stand é o conjunto dos centros de custo dele, e o número da
// tela só quer dizer alguma coisa somando todos. Quem não tem alçada em TODOS
// não vê o stand — nem na lista, nem pela URL.
//
// A alternativa (mostrar só a parte que a pessoa vê) foi descartada de
// propósito: metade do custo de um stand não é informação útil, é um número
// que parece o custo do stand e não é.
//
// Régua única do accessScopeService (com a heurística de sub-CC do Custos: quem
// tem 80001 enxerga 80002). Admin vê tudo.
async function standScope(user) {
    const scope = await getScope(user);
    const canSee = (stand) => {
        const ccs = normIds(stand?.cost_center_ids);
        if (!ccs.length) return false;
        return scope.all || ccs.every((cc) => isErpAllowed(scope, cc));
    };
    return { scope, canSee };
}

/** Carrega o stand conferindo o escopo. 404 se não existe, 403 se não é dele. */
async function loadStandForUser(id, user) {
    const row = await db.SalesStand.findByPk(Number(id), { include: withModel() });
    if (!row || row.is_active === false) throw httpError('Stand não encontrado.', 404);
    const { canSee } = await standScope(user);
    if (!canSee(plain(row))) {
        throw httpError(
            'Este stand tem centro de custo fora da sua alçada. O acesso ao stand é por inteiro: sem todos os '
            + 'centros de custo, ele não abre.',
            403, 'OUT_OF_SCOPE',
        );
    }
    return row;
}

// ── Itens do stand ───────────────────────────────────────────────────────────

/**
 * Itens DESTE stand: os do modelo (com o que a tela marcou como "tem" ou "não
 * tem") mais os itens próprios. Item que o modelo ganhou depois entra como
 * presente; item que saiu do modelo continua listado se alguém já respondeu
 * por ele, com from_model = false.
 */
function mergeStandItems(stand, model) {
    const saved = Array.isArray(stand.items) ? stand.items : [];
    const savedByLabel = new Map(saved.map((i) => [String(i?.label || '').trim(), i]));
    const modelItems = Array.isArray(model?.items) ? model.items : [];
    const out = [];
    const seen = new Set();

    for (const label of modelItems) {
        const key = String(label || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const s = savedByLabel.get(key);
        out.push({ label: key, present: s ? s.present !== false : true, custom: false, from_model: true });
    }
    for (const item of saved) {
        const key = String(item?.label || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ label: key, present: item.present !== false, custom: item.custom !== false, from_model: false });
    }
    return out;
}

export async function updateStandItems({ id, payload = {}, userId, user }) {
    const row = await loadStandForUser(id, user);
    const list = Array.isArray(payload.items) ? payload.items : [];
    const seen = new Set();
    row.items = list
        .map((i) => ({
            label: String(i?.label || '').trim(),
            present: i?.present !== false,
            custom: !!i?.custom,
        }))
        .filter((i) => {
            if (!i.label || seen.has(i.label)) return false;
            seen.add(i.label);
            return true;
        });
    row.updated_by = userId || null;
    await row.save();
    const stand = plain(row);
    return { items: mergeStandItems(stand, stand.model) };
}

// ── Gasto classificado ───────────────────────────────────────────────────────

/**
 * Lançamentos do stand já com tipo (construção × recorrência) e categoria
 * resolvidos, mais o resumo.
 */
async function classifiedSpend(stand, { categories, classesByStand } = {}) {
    const cats = categories && categories.length ? categories : await listCategories();
    const overrides = classesByStand
        ? (classesByStand.get(Number(stand.id)) || [])
        : (await db.SalesStandExpenseClass.findAll({ where: { stand_id: stand.id }, raw: true }));
    const alvo = normIds(stand.cost_center_ids);
    const raw = await listStandExpenseItems(alvo);
    const ccSet = new Set(alvo);
    const items = applyClassification(raw.filter((i) => ccSet.has(i.costCenterId)), cats, overrides);
    return { items, summary: summarize(items), categories: cats };
}

const currentYm = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Quanto o stand custa por mês para ficar de pé: média da recorrência nos
 * últimos meses FECHADOS (o mês corrente entra pela metade no backup e puxaria
 * a média para baixo).
 */
function recurringMonthly(summary, months = 3) {
    const now = currentYm();
    const fechados = (summary.byMonth || []).filter((m) => m.ym < now && m.recorrencia > 0);
    if (!fechados.length) return 0;
    const ult = fechados.slice(-months);
    return Math.round((ult.reduce((s, m) => s + m.recorrencia, 0) / ult.length) * 100) / 100;
}

// Lista stands com o gasto ao vivo agregado. Sienge fora do ar não derruba a
// tela: devolve spend zerado com spend_unavailable = true.
export async function listStands({ user } = {}) {
    const rows = await db.SalesStand.findAll({
        where: { is_active: true },
        include: withModel(),
        order: [['name', 'ASC']],
    });
    const { canSee } = await standScope(user);
    const stands = rows.map(plain).filter(canSee);

    let unavailable = false;
    let names = new Map();
    let categories = [];
    let classesByStand = new Map();
    try {
        const classes = stands.length
            ? await db.SalesStandExpenseClass.findAll({ where: { stand_id: stands.map((s) => s.id) }, raw: true })
            : [];
        classesByStand = classes.reduce((map, c) => {
            const list = map.get(Number(c.stand_id)) || [];
            list.push(c);
            map.set(Number(c.stand_id), list);
            return map;
        }, new Map());
        [names, categories] = await Promise.all([ccNameMap(), listCategories()]);
    } catch (err) {
        console.warn('[salesStand.listStands] meta indisponível:', err?.message || err);
    }

    // Capa dos cartões: a primeira foto de cada stand, numa consulta só.
    const capas = new Map();
    const fotosPorStand = new Map();
    if (stands.length) {
        const fotos = await db.SalesStandImage.findAll({
            where: { stand_id: stands.map((s) => s.id) },
            order: [['sort_order', 'ASC'], ['id', 'ASC']],
            raw: true,
        });
        for (const f of fotos) {
            const sid = Number(f.stand_id);
            if (!capas.has(sid)) capas.set(sid, f.url);
            fotosPorStand.set(sid, (fotosPorStand.get(sid) || 0) + 1);
        }
    }

    const items = [];
    for (const s of stands) {
        let summary = { totals: { construcao: 0, recorrencia: 0, esporadica: 0, sem_classificacao: 0, total: 0 }, byMonth: [] };
        try {
            ({ summary } = await classifiedSpend(s, { categories, classesByStand }));
        } catch (err) {
            console.warn('[salesStand.listStands] Sienge indisponível:', err?.message || err);
            unavailable = true;
        }
        const snapshot = s.status === 'defined' ? Number(s.construction_value) || 0 : null;
        items.push({
            ...s,
            items: mergeStandItems(s, s.model),
            cost_center_names: (s.cost_center_ids || []).map((id) => names.get(Number(id)) || `CC ${id}`),
            spend_total: summary.totals.total,
            // Construção: o congelado quando o stand está definido, o apurado
            // enquanto ele está em rascunho.
            construction_value: snapshot !== null ? snapshot : summary.totals.construcao,
            construction_live: summary.totals.construcao,
            // Recorrência é a soma do que está classificado como tal — não é
            // mais "tudo que entrou depois da definição".
            maintenance_value: summary.totals.recorrencia,
            recurring_monthly: recurringMonthly(summary),
            sporadic_value: summary.totals.esporadica,
            unclassified_value: summary.totals.sem_classificacao,
            cover_url: capas.get(Number(s.id)) || null,
            images_count: fotosPorStand.get(Number(s.id)) || 0,
            month_series: (summary.byMonth || []).map((m) => m.total),
        });
    }

    return { spend_unavailable: unavailable || undefined, items };
}

// Detalhe do gasto de um stand: por mês, por conta e por CC (visão agregada).
export async function getStandSpend({ id, user }) {
    const row = await loadStandForUser(id, user);
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

/** A tela de detalhe inteira: stand, itens, fotos, lançamentos, resumo e padrões. */
export async function getStandDetail({ id, user }) {
    const row = await loadStandForUser(id, user);
    const stand = plain(row);

    let names = new Map();
    let spend = { items: [], summary: summarize([]), categories: [] };
    let unavailable = false;
    try {
        names = await ccNameMap().catch(() => new Map());
        spend = await classifiedSpend(stand);
    } catch (err) {
        console.warn('[salesStand.getStandDetail] Sienge indisponível:', err?.message || err);
        unavailable = true;
        spend.categories = await listCategories().catch(() => []);
    }

    const images = await db.SalesStandImage.findAll({
        where: { stand_id: stand.id },
        order: [['sort_order', 'ASC'], ['id', 'ASC']],
    });
    const snapshot = stand.status === 'defined' ? Number(stand.construction_value) || 0 : null;
    const porCc = new Map((spend.summary.byCostCenter || []).map((c) => [Number(c.costCenterId), c.amount]));

    return {
        spend_unavailable: unavailable || undefined,
        stand: {
            ...stand,
            items: mergeStandItems(stand, stand.model),
            cost_centers: (stand.cost_center_ids || []).map((cc) => ({
                code: Number(cc),
                name: names.get(Number(cc)) || `CC ${cc}`,
                amount: porCc.get(Number(cc)) || 0,
            })),
            cost_center_names: (stand.cost_center_ids || []).map((cc) => names.get(Number(cc)) || `CC ${cc}`),
            spend_total: spend.summary.totals.total,
            construction_value: snapshot !== null ? snapshot : spend.summary.totals.construcao,
            construction_live: spend.summary.totals.construcao,
            maintenance_value: spend.summary.totals.recorrencia,
            recurring_monthly: recurringMonthly(spend.summary),
            sporadic_value: spend.summary.totals.esporadica,
            unclassified_value: spend.summary.totals.sem_classificacao,
            images: images.map(plain),
            images_max: MAX_IMAGES,
        },
        expenses: spend.items,
        summary: spend.summary,
        patterns: detectPatterns(spend.items),
        categories: spend.categories,
    };
}

/** Classifica lançamentos em lote: marca como construção ou recorrência e/ou troca a categoria. */
export async function classifyExpenses({ id, payload = {}, userId, user }) {
    const row = await loadStandForUser(id, user);
    const keys = [...new Set((Array.isArray(payload.keys) ? payload.keys : [])
        .map((k) => String(k || '').trim()).filter(Boolean))];
    if (!keys.length) throw httpError('Selecione ao menos um lançamento.', 400);

    // reset = o lançamento volta a herdar o tipo da categoria da conta.
    if (payload.reset) {
        await db.SalesStandExpenseClass.destroy({ where: { stand_id: row.id, expense_key: keys } });
        return { ok: true, cleared: keys.length };
    }

    const kind = normKind(payload.kind);
    let categoryId = null;
    if (payload.category_id) {
        const cat = await db.SalesStandExpenseCategory.findByPk(Number(payload.category_id));
        if (!cat) throw httpError('Categoria não encontrada.', 400);
        categoryId = cat.id;
    }
    if (!kind && !categoryId) {
        throw httpError('Escolha o tipo (construção, recorrência ou esporádica) ou uma categoria.', 400);
    }

    const existentes = await db.SalesStandExpenseClass.findAll({
        where: { stand_id: row.id, expense_key: keys },
    });
    const byKey = new Map(existentes.map((e) => [e.expense_key, e]));
    const categoria = categoryId ? await db.SalesStandExpenseCategory.findByPk(categoryId) : null;

    for (const key of keys) {
        const atual = byKey.get(key);
        // Categoria escolhida sem tipo explícito: o tipo vem dela.
        const novoKind = kind || (categoria ? categoria.kind : atual?.kind) || 'recorrencia';
        if (atual) {
            atual.kind = novoKind;
            if (payload.category_id !== undefined) atual.category_id = categoryId;
            atual.classified_by = userId || null;
            await atual.save();
        } else {
            await db.SalesStandExpenseClass.create({
                stand_id: row.id,
                expense_key: key,
                kind: novoKind,
                category_id: categoryId,
                classified_by: userId || null,
            });
        }
    }
    return { ok: true, classified: keys.length };
}

/**
 * Conferência do departamento nos centros de custo dos stands que ESTA pessoa
 * enxerga. É o instrumento para validar a correção dos títulos: mostra o que
 * está certo, o que está no departamento sem ser conta de stand e o que é conta
 * de stand sem o departamento.
 */
export async function getDepartmentAudit({ user }) {
    const rows = await db.SalesStand.findAll({ where: { is_active: true }, raw: true });
    const { canSee } = await standScope(user);
    const stands = rows.filter(canSee);
    const ccs = normIds(stands.flatMap((s) => s.cost_center_ids || []));

    const [audit, freshness, names, cfg] = await Promise.all([
        ccs.length ? listDepartmentDivergence(ccs) : Promise.resolve({ totals: {}, rows: [] }),
        getDataFreshness().catch(() => ({ lastChange: null })),
        ccNameMap().catch(() => new Map()),
        getSettings(),
    ]);

    const porStand = new Map(stands.map((s) => [s.id, {
        id: s.id, name: s.name, cost_center_ids: normIds(s.cost_center_ids),
    }]));
    const standDoCc = new Map();
    for (const st of porStand.values()) {
        for (const cc of st.cost_center_ids) if (!standDoCc.has(cc)) standDoCc.set(cc, st.name);
    }

    return {
        settings: cfg,
        freshness,
        totals: audit.totals,
        rows: audit.rows.map((r) => ({
            ...r,
            costCenterName: names.get(r.costCenterId) || r.costCenterName || `CC ${r.costCenterId}`,
            standName: standDoCc.get(r.costCenterId) || null,
        })),
    };
}

/**
 * Confere AO VIVO, na API do Sienge, os títulos que o espelho aponta como
 * divergentes. É o "já corrigiram?" sem esperar a carga do dia seguinte.
 * Nada é escrito no ERP: só leitura, um GET por título.
 */
export async function revalidateDepartmentAudit({ user, limit = 40, offset = 0 }) {
    const rows = await db.SalesStand.findAll({ where: { is_active: true }, raw: true });
    const { canSee } = await standScope(user);
    const stands = rows.filter(canSee);
    const ccs = normIds(stands.flatMap((s) => s.cost_center_ids || []));
    if (!ccs.length) return { checked: [], total: 0, limit, offset: 0, resolved: 0, pending: 0, errors: 0 };

    // Teto baixo de proposito: a API do Sienge recusa acima de ~100 chamadas por
    // minuto, e uma conferencia que demora tres minutos e uma conferencia que
    // ninguem roda. A tela oferece continuar do ponto em que parou.
    const teto = Math.min(Math.max(Number(limit) || 40, 1), 150);
    const ini = Math.max(0, Number(offset) || 0);
    const { bills, total } = await listDivergentBills(ccs, { limit: teto, offset: ini });
    const checked = await checkBillsDepartmentLive(bills);

    const names = await ccNameMap().catch(() => new Map());
    const standDoCc = new Map();
    for (const st of stands) {
        for (const cc of normIds(st.cost_center_ids)) if (!standDoCc.has(cc)) standDoCc.set(cc, st.name);
    }

    return {
        // O teto é dito em voz alta: "conferi 150 de 260" não pode virar
        // "conferi tudo" por omissão.
        total,
        limit: teto,
        offset: ini,
        // Quanto ficou de fora e dito em voz alta: "conferi 40 de 134" nao pode
        // virar "conferi tudo" por omissao.
        remaining: Math.max(0, total - (ini + bills.length)),
        truncated: total > ini + bills.length,
        resolved: checked.filter((c) => c.resolved === true).length,
        pending: checked.filter((c) => c.resolved === false).length,
        errors: checked.filter((c) => c.error).length,
        checked: checked.map((c) => ({
            ...c,
            costCenterName: names.get(c.costCenterId) || `CC ${c.costCenterId}`,
            standName: standDoCc.get(c.costCenterId) || null,
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

// Ninguém cadastra (nem move) um stand para um empreendimento que não enxerga.
async function assertCcInScope(ccIds, user) {
    const { scope } = await standScope(user);
    if (scope.all) return;
    const fora = ccIds.filter((cc) => !isErpAllowed(scope, cc));
    if (fora.length) {
        throw httpError(`Centro de custo fora da sua alçada: ${fora.join(', ')}.`, 403, 'OUT_OF_SCOPE');
    }
}

export async function createStand({ payload = {}, userId, user }) {
    const { name, ccIds } = validateStandPayload(payload);
    await assertCcInScope(ccIds, user);
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

export async function updateStand({ id, payload = {}, userId, user }) {
    const row = await loadStandForUser(id, user);

    // Modelo e centros de custo mudam o que o stand É e de onde vem o dinheiro
    // dele. Depois de definido, o custo de construção está congelado sobre
    // aquele conjunto de centros de custo — trocar sem reabrir deixaria o
    // número congelado falando de um stand que não existe mais.
    const trocaModelo = 'model_id' in payload
        && Number(payload.model_id || 0) !== Number(row.model_id || 0);
    const trocaCcs = 'cost_center_ids' in payload
        && normIds(payload.cost_center_ids).sort().join(',') !== normIds(row.cost_center_ids).sort().join(',');
    if (row.status === 'defined' && (trocaModelo || trocaCcs)) {
        throw httpError(
            'Este stand está definido: reabra para trocar o modelo ou os centros de custo.',
            409, 'STAND_DEFINED',
        );
    }

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
        await assertCcInScope(ccIds, user);
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

export async function deleteStand({ id, user }) {
    const row = await loadStandForUser(id, user);
    // Soft delete — preserva o histórico de definição.
    row.is_active = false;
    await row.save();
    return { ok: true };
}

// Define o stand: congela como custo de construção o que ESTÁ CLASSIFICADO
// como construção. Não existe valor manual — o número é sempre a soma dos
// lançamentos, e para mudá-lo se reclassifica o lançamento na tela.
export async function defineStand({ id, userId, user }) {
    const row = await loadStandForUser(id, user);
    if (row.status === 'defined') throw httpError('Este stand já está definido.', 409, 'ALREADY_DEFINED');

    const { summary } = await classifiedSpend(plain(row));
    row.status = 'defined';
    row.defined_at = new Date();
    row.construction_value = summary.totals.construcao;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

// Reabre o stand (volta a rascunho e limpa o snapshot).
export async function undefineStand({ id, userId, user }) {
    const row = await loadStandForUser(id, user);
    if (row.status !== 'defined') throw httpError('Este stand não está definido.', 409);
    row.status = 'draft';
    row.defined_at = null;
    row.construction_value = null;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

// ── Fotos do stand ───────────────────────────────────────────────────────────

const IMAGE_BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';
const MAX_IMAGES = Number(process.env.SALES_STAND_MAX_IMAGES || 24);
// O bucket do Office recusa objeto acima de 2 MB (medido em 27/08/2026:
// file_size_limit = 2097152). A tela manda a foto já tratada e bem abaixo
// disso; este teto existe para o erro ser explicado aqui, em vez de voltar do
// Supabase como "The object exceeded the maximum allowed size".
const MAX_IMAGE_BYTES = Number(process.env.SALES_STAND_MAX_IMAGE_BYTES || 2 * 1024 * 1024);

const mb = (n) => `${(Number(n || 0) / (1024 * 1024)).toFixed(1)} MB`;

export async function listStandImages({ id, user }) {
    const row = await loadStandForUser(id, user);
    const rows = await db.SalesStandImage.findAll({
        where: { stand_id: row.id },
        order: [['sort_order', 'ASC'], ['id', 'ASC']],
    });
    return { items: rows.map(plain), max: MAX_IMAGES };
}

async function subirObjeto(buffer, path, contentType) {
    const { error } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(path, buffer, { contentType: contentType || 'image/jpeg', upsert: false });
    if (error) throw httpError(`Falha ao subir a foto: ${error.message}`, 502);
    const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
}

/**
 * Guarda a foto do stand. A tela manda a imagem já redimensionada e comprimida,
 * mais uma miniatura; se a miniatura não vier (navegador que não decodificou o
 * arquivo), a foto tratada serve de miniatura e a grade fica mais pesada.
 */
export async function addStandImage({ id, file, thumb, caption, width, height, userId, user }) {
    const row = await loadStandForUser(id, user);
    if (!file?.buffer?.length) throw httpError('Nenhuma imagem recebida.', 400);
    if (file.buffer.length > MAX_IMAGE_BYTES) {
        throw httpError(
            `A foto tem ${mb(file.buffer.length)} e o limite do armazenamento é ${mb(MAX_IMAGE_BYTES)}. `
            + 'Tente de novo por um navegador atualizado (a tela reduz a foto antes de enviar) ou envie uma imagem menor.',
            413, 'IMAGE_TOO_LARGE',
        );
    }

    const total = await db.SalesStandImage.count({ where: { stand_id: row.id } });
    if (total >= MAX_IMAGES) {
        throw httpError(`Este stand já tem ${MAX_IMAGES} fotos. Apague alguma antes de subir outra.`, 409);
    }

    const ext = (file.mimetype || '').includes('webp') ? 'webp' : 'jpg';
    const base = `office/stand-vendas/${row.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const path = `${base}.${ext}`;
    const url = await subirObjeto(file.buffer, path, file.mimetype);

    let thumbPath = null;
    let thumbUrl = null;
    if (thumb?.buffer?.length && thumb.buffer.length <= MAX_IMAGE_BYTES) {
        thumbPath = `${base}-thumb.${ext}`;
        try {
            thumbUrl = await subirObjeto(thumb.buffer, thumbPath, thumb.mimetype);
        } catch (e) {
            // Miniatura é conforto, não requisito: se ela falhar, a foto entra
            // do mesmo jeito e a grade usa a imagem cheia.
            console.warn('[salesStand.addStandImage] miniatura falhou:', e?.message || e);
            thumbPath = null;
        }
    }

    const image = await db.SalesStandImage.create({
        stand_id: row.id,
        url,
        path,
        thumb_url: thumbUrl,
        thumb_path: thumbPath,
        caption: (caption || '').trim().slice(0, 200) || null,
        content_type: file.mimetype || null,
        size_bytes: file.size || file.buffer.length,
        width: Number(width) || null,
        height: Number(height) || null,
        sort_order: total,
        uploaded_by: userId || null,
    });
    return plain(image);
}

export async function updateStandImage({ id, imageId, payload = {}, user }) {
    const row = await loadStandForUser(id, user);
    const image = await db.SalesStandImage.findOne({ where: { id: Number(imageId), stand_id: row.id } });
    if (!image) throw httpError('Foto não encontrada.', 404);
    if ('caption' in payload) image.caption = (payload.caption || '').trim().slice(0, 200) || null;
    if ('sort_order' in payload) image.sort_order = Number(payload.sort_order) || 0;
    await image.save();
    return plain(image);
}

/**
 * Reordena as fotos de uma vez. A primeira é a CAPA do stand (é ela que
 * aparece no cartão da listagem), então "definir como capa" é só mandar aquela
 * foto para o começo.
 */
export async function reorderStandImages({ id, ids, user }) {
    const row = await loadStandForUser(id, user);
    const ordem = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
    if (!ordem.length) throw httpError('Informe a nova ordem das fotos.', 400);

    const fotos = await db.SalesStandImage.findAll({ where: { stand_id: row.id } });
    const porId = new Map(fotos.map((f) => [f.id, f]));
    let pos = 0;
    for (const imageId of ordem) {
        const foto = porId.get(imageId);
        if (!foto) continue;
        foto.sort_order = pos++;
        await foto.save();
        porId.delete(imageId);
    }
    // Foto que não veio na lista vai para o fim, preservando a ordem relativa.
    for (const foto of [...porId.values()].sort((a, b) => a.sort_order - b.sort_order)) {
        foto.sort_order = pos++;
        await foto.save();
    }
    return listStandImages({ id, user });
}

export async function deleteStandImage({ id, imageId, user }) {
    const row = await loadStandForUser(id, user);
    const image = await db.SalesStandImage.findOne({ where: { id: Number(imageId), stand_id: row.id } });
    if (!image) throw httpError('Foto não encontrada.', 404);
    const objetos = [image.path, image.thumb_path].filter(Boolean);
    if (objetos.length) {
        const { error } = await supabase.storage.from(IMAGE_BUCKET).remove(objetos);
        // Objeto órfão no bucket não pode travar a tela; o registro sai de qualquer jeito.
        if (error) console.warn('[salesStand.deleteStandImage] bucket:', error.message);
    }
    await image.destroy();
    return { ok: true };
}

// ── Seed dos 4 modelos padrão (Standard/Medium/Plus/Premium) ─────────────────
// Faixas propositalmente ambíguas (de/até; máx 0 = aberta "X+").

const DEFAULT_MODELS = [
    {
        name: 'Stand Standard',
        description: 'Contêiner ou sala comercial. Praticidade e custo-benefício para lançamentos de entrada: ambiente funcional, direto ao ponto, otimizado para o primeiro contato com o cliente e a captação eficiente de leads.',
        avg_value_min: 20000,
        avg_value_max: 50000,
        avg_area_min: 14,
        avg_area_max: 22,
        items: [
            'Estrutura: contêiner ou sala comercial',
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
        description: 'Contêiner ou espaço comercial. Equilíbrio e versatilidade para empreendimentos de médio padrão: espaço confortável que valoriza a marca, facilita a apresentação de maquetes e a simulação de condições de compra.',
        avg_value_min: 50000,
        avg_value_max: 80000,
        avg_area_min: 25,
        avg_area_max: 40,
        items: [
            'Estrutura: contêiner ou espaço comercial',
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
        description: 'Espaço comercial + executivo, com mais área e salas de reunião privativas. Sofisticação e conforto para projetos de alto padrão: atmosfera refinada, materiais de melhor acabamento e iluminação planejada.',
        avg_value_min: 80000,
        avg_value_max: 110000,
        avg_area_min: 45,
        avg_area_max: 70,
        items: [
            'Estrutura: espaço comercial + executivo',
            'Ar-condicionado central',
            'Recepção com lounge de espera',
            'Mesas de atendimento (4)',
            'Salas de reunião privativas (2)',
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
        description: 'Espaço executivo amplo, com decorado. O ápice do mercado de luxo e grandes lançamentos: galeria imersiva e imponente, arquitetura marcante, elegância e experiência sensorial completa para o comprador.',
        avg_value_min: 110000,
        avg_value_max: 0, // 110 mil ou mais
        avg_area_min: 80,
        avg_area_max: 0, // 80 m² ou mais
        items: [
            'Estrutura: espaço executivo amplo',
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
    if (count === 0) {
        await db.SalesStandModel.bulkCreate(DEFAULT_MODELS);
        console.log('✅ Stand de Vendas: 4 modelos padrão criados (Standard/Medium/Plus/Premium).');
        return;
    }
    // Tabela já populada: atualiza faixas/descrição/itens dos modelos padrão
    // que NUNCA foram editados na tela (updated_by null = ainda como o seed
    // deixou). Modelo editado ou excluído pelo usuário fica intocado.
    for (const def of DEFAULT_MODELS) {
        const row = await db.SalesStandModel.findOne({ where: { name: def.name, updated_by: null } });
        if (!row) continue;
        row.description = def.description;
        row.avg_value_min = def.avg_value_min;
        row.avg_value_max = def.avg_value_max;
        row.avg_area_min = def.avg_area_min;
        row.avg_area_max = def.avg_area_max;
        row.items = def.items;
        await row.save();
    }
}

export default {
    listCostCenters,
    listCostCentersForUser,
    listContas,
    listDepartments,
    getSettings,
    updateSettings,
    listModels,
    createModel,
    updateModel,
    deleteModel,
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    listStands,
    getStandSpend,
    getStandDetail,
    getDepartmentAudit,
    revalidateDepartmentAudit,
    classifyExpenses,
    updateStandItems,
    createStand,
    updateStand,
    deleteStand,
    defineStand,
    undefineStand,
    listStandImages,
    addStandImage,
    updateStandImage,
    reorderStandImages,
    deleteStandImage,
    clearSpendCache,
    seedSalesStandModels,
    seedSalesStandExpenseCategories,
    seedSalesStandSettings,
};
