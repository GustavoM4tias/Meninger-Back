// services/emeReports/ReportDataService.js
//
// Relatórios INTERATIVOS: o spec pode declarar `filters` (o que o leitor pode
// consultar) e `datasets` (consultas parametrizadas às tools de dados). Blocos
// com `bind` têm as props recalculadas AQUI, de forma determinística — a IA
// define a estrutura na montagem, mas nenhum número passa por ela na hora da
// consulta.
//
// Segurança (inegociável):
//  - As consultas rodam SEMPRE com o usuário que está vendo o relatório
//    (SecureRunner p/ tools do registry, gate de alçada p/ legadas). O escopo
//    por empreendimento é aplicado DENTRO das tools (accessScopeService),
//    fail-closed. Filtro nunca amplia o que o leitor pode ver.
//  - Só tools da allowlist DATA_TOOL_NAMES; só argumentos DECLARADOS pela tool;
//    args de forma (group_by/metric/format/limit) não podem virar filtro.
//  - Valores de filtro são sanitizados (tamanho, control chars, formato de data).
//  - O link público NUNCA chega aqui: visitante recebe o snapshot congelado.

import {
  executeTool as officeExecuteTool,
  legacyToolAllowed,
  TOOL_DECLARATIONS as OFFICE_TOOL_DECLARATIONS,
} from '../OfficeAI/OfficeChatService.js';
import { findTool } from '../OfficeAI/ToolRegistry.js';
import { runTool as runSecureTool } from '../OfficeAI/SecureRunner.js';

// ── Allowlist de tools de dados (fonte única; ReportChatService importa) ─────
// Tudo que a Eme consegue consultar no Office e que faz sentido virar
// relatório entra aqui. O que ela alcança no chat, ela alcança no relatório —
// sempre com as alçadas de quem executa (SecureRunner nas tools do registry,
// gate legacyToolAllowed nas legadas).
export const DATA_TOOL_NAMES = [
  // Marketing / comercial
  'query_leads', 'query_events', 'query_enterprises', 'get_enterprise_detail',
  'query_precadastros', 'query_reservas', 'query_mcmv',
  'query_condition_sheets', 'get_condition_sheet',
  'imobiliarias_search',
  // Vendas / metas
  'get_consolidated_sales', 'query_projections',
  // Financeiro
  'query_custos', 'query_boletos', 'query_repasses_contratos', 'query_repasses',
  // Operação / pessoas
  'query_checklists', 'query_event_plans', 'query_people',
];
export const DATA_TOOL_LABELS = {
  query_leads: 'Leads de marketing',
  query_events: 'Eventos',
  query_enterprises: 'Empreendimentos',
  get_enterprise_detail: 'Detalhe do empreendimento',
  query_precadastros: 'Pré-cadastros',
  query_reservas: 'Reservas',
  query_mcmv: 'Teto MCMV',
  query_condition_sheets: 'Fichas comerciais',
  get_condition_sheet: 'Ficha comercial',
  imobiliarias_search: 'Imobiliárias parceiras',
  get_consolidated_sales: 'Vendas (Faturamento)',
  query_projections: 'Projeção de vendas',
  query_custos: 'Custos financeiros',
  query_boletos: 'Boletos Caixa (ato)',
  query_repasses_contratos: 'Fila do validador de contratos',
  query_repasses: 'Repasses',
  query_checklists: 'Checklists',
  query_event_plans: 'Plano de eventos',
  query_people: 'Pessoas e organograma',
};

// ── Limites do spec interativo ───────────────────────────────────────────────
const MAX_FILTERS = 8;
const MAX_DATASETS = 8;
const MAX_OPTIONS = 100;
const MAX_TABLE_ROWS = 100;
const MAX_TIMELINE_EVENTS = 40;
const MAX_STR = 120;

const FILTER_TYPES = new Set(['select', 'text', 'date-range']);
// Args que mudam a FORMA do retorno; o autor pode fixá-los em base_args, mas o
// leitor jamais os controla via filtro.
const FORBIDDEN_FILTER_ARGS = new Set(['group_by', 'metric', 'format', 'limit']);

const KEY_RE = /^[a-z0-9_-]{1,40}$/;
const ARG_RE = /^[a-z0-9_]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PATH_RE = /^[a-zA-Z0-9_.]{1,80}$/;

function cleanStr(value, max = MAX_STR) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

// ── Normalização (chamada pelo normalizeSpec ao salvar o spec) ───────────────

export function normalizeFilters(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const f of raw.slice(0, MAX_FILTERS)) {
    if (!f || typeof f !== 'object') continue;
    const key = cleanStr(f.key, 40).toLowerCase();
    const type = FILTER_TYPES.has(f.type) ? f.type : 'text';
    if (!KEY_RE.test(key) || seen.has(key)) continue;
    const arg = type === 'date-range' ? null : cleanStr(f.arg, 40).toLowerCase();
    if (type !== 'date-range' && (!ARG_RE.test(arg) || FORBIDDEN_FILTER_ARGS.has(arg))) continue;
    seen.add(key);
    const filter = { key, type, label: cleanStr(f.label, 60) || key };
    if (arg) filter.arg = arg;
    if (f.placeholder) filter.placeholder = cleanStr(f.placeholder, 60);
    if (type === 'select') {
      if (Array.isArray(f.options)) {
        filter.options = [...new Set(f.options.map((o) => cleanStr(o)).filter(Boolean))].slice(0, MAX_OPTIONS);
      }
      if (f.options_from && typeof f.options_from === 'object') {
        const ds = cleanStr(f.options_from.dataset, 40);
        const field = cleanStr(f.options_from.field, 60);
        if (ds && field) filter.options_from = { dataset: ds, field };
      }
    }
    // Valor inicial. Em date-range aceita tanto `default` quanto `default_range`
    // (nome que a ferramenta da Eme expõe, por o schema do Gemini exigir tipo
    // fixo por campo).
    const brutoDefault = type === 'date-range' ? (f.default_range || f.default) : f.default;
    if (brutoDefault != null && brutoDefault !== '') {
      filter.default = type === 'date-range'
        ? normalizeDateRange(brutoDefault)
        : cleanStr(brutoDefault);
      if (!filter.default) delete filter.default;
    }
    out.push(filter);
  }
  return out;
}

function normalizeDateRange(value) {
  const v = value && typeof value === 'object' ? value : {};
  const range = {};
  if (DATE_RE.test(String(v.from || ''))) range.from = v.from;
  if (DATE_RE.test(String(v.to || ''))) range.to = v.to;
  return Object.keys(range).length ? range : null;
}

export function normalizeDatasets(raw, filters = []) {
  if (!Array.isArray(raw)) return [];
  const filterKeys = new Set(filters.map((f) => f.key));
  const seen = new Set();
  const out = [];
  for (const d of raw.slice(0, MAX_DATASETS)) {
    if (!d || typeof d !== 'object') continue;
    const id = cleanStr(d.id, 40).toLowerCase();
    const tool = cleanStr(d.tool, 60);
    if (!KEY_RE.test(id) || seen.has(id) || !DATA_TOOL_NAMES.includes(tool)) continue;
    seen.add(id);

    const baseArgs = {};
    const rawArgs = d.base_args && typeof d.base_args === 'object' ? d.base_args : {};
    for (const [k, v] of Object.entries(rawArgs).slice(0, 20)) {
      const key = cleanStr(k, 40).toLowerCase();
      if (!ARG_RE.test(key)) continue;
      // O teto de 200 cortava a tabela/exportação de um empreendimento com
      // centenas de registros sem ninguém perceber.
      if (typeof v === 'number' && Number.isFinite(v)) baseArgs[key] = key === 'limit' ? Math.min(Math.max(1, v), 2000) : v;
      else if (typeof v === 'boolean') baseArgs[key] = v;
      else if (typeof v === 'string') baseArgs[key] = cleanStr(v, 200);
    }

    const accepts = Array.isArray(d.accepts)
      ? [...new Set(d.accepts.map((k) => cleanStr(k, 40).toLowerCase()))].filter((k) => filterKeys.has(k)).slice(0, MAX_FILTERS)
      : [];

    out.push({
      id,
      tool,
      label: cleanStr(d.label, 60) || DATA_TOOL_LABELS[tool] || tool,
      base_args: baseArgs,
      accepts,
    });
  }
  return out;
}

// Bind de bloco: liga o bloco a um dataset. A projeção é derivada do TIPO do
// bloco (chart-bar → chart, table → table...), então o bind só carrega o
// dataset e os detalhes de mapeamento.
export function normalizeBind(raw, datasets = []) {
  if (!raw || typeof raw !== 'object') return null;
  const dataset = cleanStr(raw.dataset, 40).toLowerCase();
  if (!dataset || !datasets.some((d) => d.id === dataset)) return null;
  const bind = { dataset };

  if (raw.aggregate && typeof raw.aggregate === 'object') {
    const a = raw.aggregate;
    const groupBy = cleanStr(a.group_by, 60);
    if (groupBy) {
      bind.aggregate = { group_by: groupBy };
      if (['count', 'sum', 'avg'].includes(a.metric)) bind.aggregate.metric = a.metric;
      if (a.metric_field) bind.aggregate.metric_field = cleanStr(a.metric_field, 60);
      if (['day', 'week', 'month'].includes(a.date_granularity)) bind.aggregate.date_granularity = a.date_granularity;
      if (Number.isFinite(Number(a.top))) bind.aggregate.top = Math.min(Math.max(1, Number(a.top)), 50);
    }
  }
  if (Array.isArray(raw.values)) {
    bind.values = raw.values.slice(0, 8)
      .map((v) => (v && typeof v === 'object' && PATH_RE.test(String(v.path || '')) ? { path: v.path } : null))
      .filter(Boolean);
    if (!bind.values.length) delete bind.values;
  }
  if (raw.path && PATH_RE.test(String(raw.path))) bind.path = raw.path;
  if (Array.isArray(raw.fields)) {
    bind.fields = [...new Set(raw.fields.map((f) => cleanStr(f, 60)).filter(Boolean))].slice(0, 20);
    if (!bind.fields.length) delete bind.fields;
  }
  if (raw.map && typeof raw.map === 'object') {
    const map = {};
    for (const k of ['date', 'title', 'description', 'tone']) {
      if (raw.map[k]) map[k] = cleanStr(raw.map[k], 60);
    }
    if (map.date && map.title) bind.map = map;
  }
  if (raw.series_name) bind.series_name = cleanStr(raw.series_name, 60);
  if (Number.isFinite(Number(raw.top))) bind.top = Math.min(Math.max(1, Number(raw.top)), 50);
  return bind;
}

// ── Análise de linhas (compartilhada com o ReportChatService) ────────────────

export function extractRows(result) {
  if (!result || typeof result !== 'object') return [];
  for (const key of ['rows', 'data', 'items', 'list', 'leads', 'reservas', 'precadastros', 'results']) {
    if (Array.isArray(result[key])) return result[key];
  }
  const firstArray = Object.values(result).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
  return firstArray || [];
}

// Buckets em UTC, o mesmo fuso da sessão do Postgres — as tools rotulam mês/dia
// com TO_CHAR/DATE no banco, e agrupar aqui pelo fuso local do processo jogava
// os registros da virada do dia para o mês vizinho: o drill de janeiro trazia
// 471 linhas para uma barra de 474.
function bucketDate(value, granularity) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  if (granularity === 'month') return d.toISOString().slice(0, 7);
  if (granularity === 'week') {
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

export function analyzeRows(rows, { group_by, metric = 'count', metric_field, date_granularity, top = 10 }) {
  if (!rows.length) return { error: 'Nenhum registro disponível dessa consulta para analisar.' };
  const sample = rows[0];
  if (!(group_by in sample)) {
    return {
      error: `Campo "${group_by}" não existe nos registros.`,
      availableFields: Object.keys(sample).slice(0, 40),
    };
  }

  const groups = new Map();
  for (const row of rows) {
    let key = row[group_by];
    if (key === null || key === undefined || key === '') key = '(não informado)';
    else if (date_granularity) key = bucketDate(key, date_granularity);
    else key = String(key);

    const g = groups.get(key) || { count: 0, sum: 0 };
    g.count += 1;
    if (metric_field != null) {
      const n = Number(row[metric_field]);
      if (Number.isFinite(n)) g.sum += n;
    }
    groups.set(key, g);
  }

  let items = [...groups.entries()].map(([label, g]) => ({
    label,
    value: metric === 'sum' ? g.sum : metric === 'avg' ? (g.count ? g.sum / g.count : 0) : g.count,
    count: g.count,
  }));

  // Série temporal mantém ordem cronológica; o resto ordena por valor
  if (date_granularity) items.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  else items.sort((a, b) => b.value - a.value);

  const total = items.reduce((s, i) => s + i.value, 0);
  const limited = date_granularity ? items : items.slice(0, top);

  return {
    groupBy: group_by,
    metric,
    total: Math.round(total * 100) / 100,
    groupCount: items.length,
    items: limited.map((i) => ({
      ...i,
      value: Math.round(i.value * 100) / 100,
      share: total ? Math.round((i.value / total) * 1000) / 10 : 0,
    })),
    // Leitura pronta para a Eme usar no texto de análise
    topLabel: limited[0]?.label ?? null,
    topShare: total && limited[0] ? Math.round((limited[0].value / total) * 1000) / 10 : null,
  };
}

// ── Argumentos permitidos por tool (declarações = contrato) ──────────────────

export function allowedArgsForTool(toolName) {
  const registry = findTool(toolName);
  if (registry?.parameters?.properties) return new Set(Object.keys(registry.parameters.properties));
  const legacy = OFFICE_TOOL_DECLARATIONS.find((d) => d.name === toolName);
  if (legacy?.parameters?.properties) return new Set(Object.keys(legacy.parameters.properties));
  return new Set();
}

// ── Sanitização dos valores vindos do leitor ─────────────────────────────────

export function sanitizeFilterValues(filters, rawValues) {
  const values = {};
  const raw = rawValues && typeof rawValues === 'object' ? rawValues : {};
  for (const f of filters) {
    const v = raw[f.key];
    if (v == null || v === '') continue;
    if (f.type === 'date-range') {
      const range = normalizeDateRange(v);
      if (range) values[f.key] = range;
    } else {
      const s = cleanStr(v);
      // select com options fixas só aceita valor da lista (options_from é
      // dinâmico — valida a forma; o escopo real é garantido pela tool)
      if (f.type === 'select' && Array.isArray(f.options) && f.options.length && !f.options.includes(s)) continue;
      if (s) values[f.key] = s;
    }
  }
  return values;
}

// ── Execução dos datasets ────────────────────────────────────────────────────

function buildDatasetArgs(dataset, filters, values) {
  const args = { ...dataset.base_args };
  const allowed = allowedArgsForTool(dataset.tool);
  for (const key of dataset.accepts) {
    const filter = filters.find((f) => f.key === key);
    const value = values[key];
    if (!filter || value == null) continue;
    if (filter.type === 'date-range') {
      if (value.from && allowed.has('data_inicio')) args.data_inicio = value.from;
      if (value.to && allowed.has('data_fim')) args.data_fim = value.to;
    } else if (filter.arg && allowed.has(filter.arg) && !FORBIDDEN_FILTER_ARGS.has(filter.arg)) {
      args[filter.arg] = value;
    }
  }
  return args;
}

// Cache curto por relatório+usuário+args: protege o banco de troca rápida de
// filtros e de re-render, sem segurar dado velho por muito tempo.
const CACHE_TTL_MS = 3 * 60 * 1000;
const CACHE_MAX = 300;
const _cache = new Map(); // key -> { at, result }

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.result;
}
function cachePut(key, result) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
  _cache.set(key, { at: Date.now(), result });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now - v.at > CACHE_TTL_MS) _cache.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

async function runDataset(dataset, args, user) {
  if (findTool(dataset.tool)) {
    return runSecureTool({ user, toolName: dataset.tool, args, context: 'OFFICE' });
  }
  // Tool legada: gate de alçada explícito (o executor legado não valida sozinho)
  if (!(await legacyToolAllowed(user, dataset.tool))) {
    return { error: 'Você não tem acesso a esta fonte de dados.' };
  }
  return officeExecuteTool(dataset.tool, args, user);
}

export async function runReportData({ report, user, rawFilterValues }) {
  const spec = report.spec || {};
  const filters = Array.isArray(spec.filters) ? spec.filters : [];
  const datasets = Array.isArray(spec.datasets) ? spec.datasets : [];
  if (!datasets.length) {
    return { ok: false, error: 'Este relatório não tem consultas interativas.' };
  }

  const values = sanitizeFilterValues(filters, rawFilterValues);
  const results = {}; // datasetId -> result
  const datasetErrors = [];

  for (const dataset of datasets) {
    const args = buildDatasetArgs(dataset, filters, values);
    const cacheKey = `${report.id}:${user.id}:${dataset.id}:${JSON.stringify(args)}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      results[dataset.id] = cached;
      continue;
    }
    try {
      const result = await runDataset(dataset, args, user);
      if (result?.error) {
        datasetErrors.push({ id: dataset.id, label: dataset.label, error: String(result.error).slice(0, 200) });
      } else {
        results[dataset.id] = result;
        cachePut(cacheKey, result);
      }
    } catch (err) {
      console.warn('[ReportDataService] dataset', dataset.id, err?.message);
      datasetErrors.push({ id: dataset.id, label: dataset.label, error: 'Falha ao consultar os dados.' });
    }
  }

  const { props, blockErrors } = projectSpec(spec, results);
  const options = computeFilterOptions(filters, results);

  return {
    ok: true,
    values,
    props,
    blockErrors,
    options,
    datasetErrors,
    refreshedAt: new Date().toISOString(),
  };
}

// ── Drill: linhas por trás de um item clicado no relatório ───────────────────
// O leitor clica numa fatia/barra/posição e recebe a LISTA de registros que
// compõem aquele número. Tudo determinístico: o bloco/spec dizem qual dataset
// e qual campo agrupa; o valor clicado só serve de comparação depois que as
// linhas já voltaram da tool (rodada com as alçadas de quem pede).

const MAX_DRILL_ROWS = 200;
const MAX_EXPORT_ROWS = 1000;
const MAX_EXPORT_COLS = 24;
// Universo pedido à tool quando o relatório precisa das linhas cruas (drill,
// export). O corte de exibição continua sendo MAX_DRILL_ROWS/MAX_EXPORT_ROWS,
// mas a CONTAGEM passa a ser verdadeira.
const MAX_RAW_ROWS = 2000;

// Colunas exportáveis/listáveis: só campos escalares (objeto aninhado não cabe
// em célula) presentes na primeira linha.
function scalarColumns(rows, cap = MAX_EXPORT_COLS) {
  const first = rows[0] || {};
  return Object.keys(first)
    .filter((k) => {
      const v = first[k];
      return v == null || ['string', 'number', 'boolean'].includes(typeof v);
    })
    .slice(0, cap)
    .map((key) => ({ key, label: key }));
}

function pickRow(row, columns) {
  const out = {};
  for (const c of columns) out[c.key] = row?.[c.key] ?? null;
  return out;
}

// Linhas CRUAS de um dataset. Se o autor pediu o retorno já agrupado
// (base_args.group_by), reexecuta sem os args de forma para obter os registros.
async function rawDatasetRows(dataset, args, user, reportId) {
  const shapeless = { ...args };
  for (const k of ['group_by', 'metric', 'format']) delete shapeless[k];
  // Sem group_by a tool volta ao modo listagem, cujo padrão é 50 linhas: o
  // drill-down de uma barra com 300 registros mostrava 50 e dizia "300".
  if (allowedArgsForTool(dataset.tool).has('limit')) shapeless.limit = MAX_RAW_ROWS;
  if (allowedArgsForTool(dataset.tool).has('format')) shapeless.format = 'list';

  const cacheKey = `${reportId}:${user.id}:${dataset.id}:raw:${JSON.stringify(shapeless)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { rows: extractRows(cached), result: cached };

  const result = await runDataset(dataset, shapeless, user);
  if (result?.error) return { error: String(result.error).slice(0, 200) };
  cachePut(cacheKey, result);
  return { rows: extractRows(result), result };
}

// O `group_by` das tools é um nome LÓGICO ("situacao", "imobiliaria", "mes"),
// mas a listagem devolve a coluna com outro nome ("situacao_nome",
// "imobiliaria_nome", "data_cad"). Comparar o valor clicado com `row[group_by]`
// achava campo nenhum e o drill abria uma lista VAZIA sem dizer por quê —
// clicar em "Reprovado (114)" mostrava zero registro.
const DRILL_ALIASES = {
  situacao: ['situacao_nome', 'situacao'],
  imobiliaria: ['imobiliaria_nome'],
  corretor: ['corretor_nome'],
  empresa_correspondente: ['cca_nome', 'empresa_correspondente_nome'],
  correspondente: ['correspondente_nome'],
  empreendimento: ['empreendimento_nome', 'empreendimento'],
  lead_origem: ['lead_origem', 'origem'],
  midia: ['midia_principal', 'lead_midia'],
  etapa: ['etapa'],
  bucket: ['bucket'],
  status_repasse: ['status_repasse'],
  tipovenda: ['tipovenda'],
};

// Campo real + granularidade de data para casar o rótulo clicado com as linhas.
function resolveDrillField(rows, groupBy, granDeclarada) {
  const amostra = rows[0] || {};
  const tem = (k) => k && Object.prototype.hasOwnProperty.call(amostra, k);

  if (groupBy === 'mes' || groupBy === 'dia') {
    const campoData = ['data_cad', 'data_reserva', 'data_status_repasse', 'data_contrato', 'data_venda']
      .find(tem) || Object.keys(amostra).find((k) => /^data(_|$)/.test(k));
    if (!campoData) return null;
    return { field: campoData, gran: groupBy === 'mes' ? 'month' : 'day' };
  }

  const candidato = [groupBy, ...(DRILL_ALIASES[groupBy] || []), `${groupBy}_nome`].find(tem);
  return candidato ? { field: candidato, gran: granDeclarada || null } : null;
}

export async function runReportDrill({ report, user, rawFilterValues, blockId, label }) {
  const spec = report.spec || {};
  const filters = Array.isArray(spec.filters) ? spec.filters : [];
  const datasets = Array.isArray(spec.datasets) ? spec.datasets : [];

  const block = (spec.blocks || []).find((b) => b?.id === blockId && b?.bind?.dataset);
  if (!block) return { ok: false, error: 'Este bloco não tem consulta vinculada.' };
  const dataset = datasets.find((d) => d.id === block.bind.dataset);
  if (!dataset) return { ok: false, error: 'Consulta do bloco não encontrada.' };

  const groupBy = block.bind.aggregate?.group_by || dataset.base_args?.group_by || null;
  // Sem `label` o leitor clicou num bloco que não tem categoria (KPI, número
  // grande, meta): a resposta é o universo inteiro da consulta que gerou aquele
  // número, e não faz sentido exigir group_by.
  const target = cleanStr(label);
  const semCategoria = !target;
  if (!semCategoria && !groupBy) {
    return { ok: false, error: 'Este bloco não permite abrir a lista de registros.' };
  }

  const values = sanitizeFilterValues(filters, rawFilterValues);
  const args = buildDatasetArgs(dataset, filters, values);
  const { rows, error } = await rawDatasetRows(dataset, args, user, report.id);
  if (error) return { ok: false, error };
  if (!rows?.length) return { ok: false, error: 'Nenhum registro disponível para o seu acesso.' };

  let matched = rows;
  if (!semCategoria) {
    const resolvido = resolveDrillField(rows, groupBy, block.bind.aggregate?.date_granularity || null);
    if (!resolvido) {
      return {
        ok: false,
        error: `Não foi possível casar "${target}" com os registros desta consulta (o agrupamento "${groupBy}" não aparece na listagem). Use a exportação para Excel para ver a lista completa.`,
      };
    }
    matched = rows.filter((r) => {
      let v = r?.[resolvido.field];
      if (v === null || v === undefined || v === '') v = '(não informado)';
      else if (resolvido.gran) v = bucketDate(v, resolvido.gran);
      else v = String(v).trim();
      return v === target;
    });
  }

  const columns = scalarColumns(matched.length ? matched : rows);
  return {
    ok: true,
    label: semCategoria ? dataset.label : target,
    // groupBy só volta quando houve categoria: é ele que habilita o "filtrar
    // por este item" na tela, que não existe para o universo inteiro.
    groupBy: semCategoria ? null : groupBy,
    scope: semCategoria ? 'dataset' : 'category',
    datasetId: dataset.id,
    datasetLabel: dataset.label,
    total: matched.length,
    truncated: matched.length > MAX_DRILL_ROWS,
    columns,
    rows: matched.slice(0, MAX_DRILL_ROWS).map((r) => pickRow(r, columns)),
  };
}

// ── Export: dados do relatório em linhas, para planilha ──────────────────────
// Mesmo caminho de segurança do /data: tools rodam com o usuário leitor e os
// filtros escolhidos por ele. O link público NUNCA chega aqui.

// Identidade da FONTE de uma consulta na exportação: tool + argumentos que
// sobram depois de tirar o que só muda a forma do retorno (o mesmo descarte que
// rawDatasetRows faz). Exportada para o front montar a lista de escolha com as
// mesmas fontes que o servidor vai devolver.
export function chaveDeFonte(tool, args = {}) {
  const semForma = { ...args };
  for (const k of ['group_by', 'metric', 'format', 'limit']) delete semForma[k];
  const ordenado = Object.keys(semForma).sort().map((k) => `${k}=${semForma[k]}`);
  return `${tool}|${ordenado.join('&')}`;
}

export async function runReportExport({ report, user, rawFilterValues, datasetIds }) {
  const spec = report.spec || {};
  const filters = Array.isArray(spec.filters) ? spec.filters : [];
  let datasets = Array.isArray(spec.datasets) ? spec.datasets : [];
  if (!datasets.length) {
    return { ok: false, error: 'Este relatório não tem consultas interativas.' };
  }

  // Seleção do leitor (modal de exportação). Ids desconhecidos são ignorados —
  // a lista do spec continua sendo o universo, o pedido só recorta.
  if (Array.isArray(datasetIds) && datasetIds.length) {
    const escolhidos = new Set(datasetIds.map((id) => cleanStr(id, 40).toLowerCase()));
    const filtrados = datasets.filter((d) => escolhidos.has(d.id));
    if (!filtrados.length) {
      return { ok: false, error: 'Nenhuma das consultas escolhidas existe neste relatório.' };
    }
    datasets = filtrados;
  }

  const values = sanitizeFilterValues(filters, rawFilterValues);
  const sheets = [];
  const datasetErrors = [];
  // A exportação reconsulta em modo LISTA (sem group_by/metric/format), então
  // dois datasets da mesma tool com o mesmo recorte devolvem exatamente as
  // mesmas linhas: um painel de funil com "pastas-kpis" e "pastas-situacao"
  // gerava duas abas idênticas. Uma aba por FONTE de dados.
  const jaExportado = new Set();

  for (const dataset of datasets) {
    const args = buildDatasetArgs(dataset, filters, values);
    const chaveFonte = chaveDeFonte(dataset.tool, args);
    if (jaExportado.has(chaveFonte)) continue;
    jaExportado.add(chaveFonte);
    try {
      const { rows, result, error } = await rawDatasetRows(dataset, args, user, report.id);
      if (error) {
        datasetErrors.push({ id: dataset.id, label: dataset.label, error });
        continue;
      }
      if (rows?.length) {
        const columns = scalarColumns(rows);
        sheets.push({
          id: dataset.id,
          label: dataset.label,
          columns,
          total: rows.length,
          truncated: rows.length > MAX_EXPORT_ROWS,
          rows: rows.slice(0, MAX_EXPORT_ROWS).map((r) => pickRow(r, columns)),
        });
      } else if (Array.isArray(result?.labels) && Array.isArray(result?.data)) {
        // Tool que só devolve o agrupado: exporta os pares label/valor
        sheets.push({
          id: dataset.id,
          label: dataset.label,
          columns: [{ key: 'label', label: 'Item' }, { key: 'value', label: 'Valor' }],
          total: result.labels.length,
          truncated: false,
          rows: result.labels.map((l, i) => ({ label: String(l), value: result.data[i] ?? 0 })),
        });
      } else {
        datasetErrors.push({ id: dataset.id, label: dataset.label, error: 'Sem registros para exportar.' });
      }
    } catch (err) {
      console.warn('[ReportDataService] export', dataset.id, err?.message);
      datasetErrors.push({ id: dataset.id, label: dataset.label, error: 'Falha ao consultar os dados.' });
    }
  }

  if (!sheets.length) {
    return { ok: false, error: datasetErrors[0]?.error || 'Nenhum dado disponível para exportar.' };
  }
  return { ok: true, sheets, values, datasetErrors, refreshedAt: new Date().toISOString() };
}

// ── Opções dinâmicas de filtro (distinct de um campo do dataset) ─────────────

function computeFilterOptions(filters, results) {
  const options = {};
  for (const f of filters) {
    if (f.type !== 'select') continue;
    if (Array.isArray(f.options) && f.options.length) {
      options[f.key] = f.options;
      continue;
    }
    if (f.options_from && results[f.options_from.dataset]) {
      const rows = extractRows(results[f.options_from.dataset]);
      const distinct = [...new Set(rows.map((r) => r?.[f.options_from.field]).filter((v) => v != null && v !== ''))]
        .map((v) => cleanStr(v))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      options[f.key] = distinct.slice(0, MAX_OPTIONS);
    }
  }
  return options;
}

// ── Projeção: resultado da tool → props do bloco ─────────────────────────────

function valueAtPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[part];
  }
  if (typeof cur === 'number') return Math.round(cur * 100) / 100;
  if (typeof cur === 'string' || typeof cur === 'boolean') return cur;
  return null;
}

// labels/values a partir do resultado: aceita retorno agrupado das tools
// ({ labels, data }) ou agrega linhas cruas via bind.aggregate.
function seriesFromResult(result, bind) {
  if (bind?.aggregate) {
    const analyzed = analyzeRows(extractRows(result), bind.aggregate);
    if (analyzed.error) return { error: analyzed.error };
    return {
      labels: analyzed.items.map((i) => i.label),
      values: analyzed.items.map((i) => i.value),
      title: null,
    };
  }
  if (Array.isArray(result?.labels) && Array.isArray(result?.data)) {
    return {
      labels: result.labels.map((l) => String(l)),
      values: result.data.map((v) => (v == null ? 0 : Number(v))),
      title: result.title || null,
    };
  }
  return { error: 'O dataset não retornou dados agrupados. Use base_args com group_by ou bind.aggregate.' };
}

const CHART_TYPES = new Set(['chart-bar', 'chart-line', 'chart-donut']);

function projectBlock(block, result) {
  const bind = block.bind;
  const type = block.type;

  if (CHART_TYPES.has(type)) {
    const s = seriesFromResult(result, bind);
    if (s.error) return { error: s.error };
    const name = bind.series_name || s.title || 'Total';
    return { props: { labels: s.labels, series: [{ name, data: s.values }] } };
  }

  if (type === 'chart-funnel') {
    const s = seriesFromResult(result, bind);
    if (s.error) return { error: s.error };
    return { props: { stages: s.labels.map((label, i) => ({ label, value: s.values[i] })) } };
  }

  if (type === 'ranking') {
    const s = seriesFromResult(result, bind);
    if (s.error) return { error: s.error };
    const top = bind.top || 10;
    return { props: { items: s.labels.slice(0, top).map((label, i) => ({ label, value: s.values[i] })) } };
  }

  if (type === 'table') {
    let columns = Array.isArray(result?.columns) ? result.columns : null;
    const rows = Array.isArray(result?.rows) ? result.rows : extractRows(result);
    if (!rows.length) return { error: 'Sem registros para a tabela.' };
    if (!columns) {
      const keys = Object.keys(rows[0] || {}).slice(0, 8);
      columns = keys.map((key) => ({ key, label: key }));
    }
    if (bind.fields?.length) columns = columns.filter((c) => bind.fields.includes(c.key));
    const fmtMap = { date: 'date', currency: 'currency', percent: 'percent' };
    // O universo real do filtro (não o tamanho da página) vira nota da tabela,
    // para o leitor nunca tomar as 100 primeiras linhas pelo total.
    const totalGeral = Number(result?.total_geral ?? rows.length) || rows.length;
    const exibidas = Math.min(rows.length, MAX_TABLE_ROWS);
    return {
      props: {
        ...(totalGeral > exibidas
          ? { footnote: `Mostrando ${exibidas} de ${totalGeral} registros. Use "Exportar > Excel" para a lista completa.` }
          : { footnote: null }),
        columns: columns.map((c) => ({
          key: c.key,
          label: c.label || c.key,
          ...(fmtMap[c.type] ? { format: fmtMap[c.type] } : {}),
        })),
        rows: rows.slice(0, MAX_TABLE_ROWS).map((r) => {
          const out = {};
          for (const c of columns) out[c.key] = r?.[c.key] ?? null;
          return out;
        }),
      },
    };
  }

  if (type === 'timeline') {
    if (!bind.map) return { error: 'Timeline com bind exige map { date, title }.' };
    const rows = extractRows(result);
    if (!rows.length) return { error: 'Sem eventos para a timeline.' };
    const events = rows
      .filter((r) => r?.[bind.map.date])
      .sort((a, b) => new Date(a[bind.map.date]) - new Date(b[bind.map.date]))
      .slice(-MAX_TIMELINE_EVENTS)
      .map((r) => ({
        date: String(r[bind.map.date]).slice(0, 10),
        title: cleanStr(r[bind.map.title], 120) || '(sem título)',
        ...(bind.map.description && r[bind.map.description] != null
          ? { description: cleanStr(r[bind.map.description], 200) } : {}),
        ...(bind.map.tone && r[bind.map.tone] ? { tone: cleanStr(r[bind.map.tone], 20) } : {}),
      }));
    return { props: { events } };
  }

  if (type === 'stat-row') {
    if (!bind.values?.length) return { error: 'stat-row com bind exige values: [{ path }].' };
    const stats = (block.props?.stats || []).map((s) => ({ ...s }));
    bind.values.forEach((v, i) => {
      const value = valueAtPath(result, v.path);
      if (value == null) return;
      if (stats[i]) stats[i].value = value;
      else stats[i] = { label: v.path, value };
    });
    return { props: { stats } };
  }

  if (type === 'big-number' || type === 'progress-goal') {
    if (!bind.path) return { error: `${type} com bind exige path.` };
    const value = valueAtPath(result, bind.path);
    if (value == null) return { error: `Caminho "${bind.path}" não encontrado no resultado.` };
    return { props: { value } };
  }

  return { error: `Bloco "${type}" não suporta bind.` };
}

export function projectSpec(spec, results) {
  const props = {};
  const blockErrors = {};
  for (const block of spec?.blocks || []) {
    if (!block?.bind?.dataset) continue;
    const result = results[block.bind.dataset];
    if (!result) {
      blockErrors[block.id] = 'Dados indisponíveis para o seu acesso.';
      continue;
    }
    try {
      const projected = projectBlock(block, result);
      if (projected.error) blockErrors[block.id] = projected.error;
      else props[block.id] = projected.props;
    } catch (err) {
      console.warn('[ReportDataService] projeção', block.id, err?.message);
      blockErrors[block.id] = 'Falha ao montar este bloco.';
    }
  }
  return { props, blockErrors };
}

export default {
  DATA_TOOL_NAMES, DATA_TOOL_LABELS,
  normalizeFilters, normalizeDatasets, normalizeBind,
  sanitizeFilterValues, runReportData, runReportDrill, runReportExport, projectSpec,
  extractRows, analyzeRows,
};
