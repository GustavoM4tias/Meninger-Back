// services/sienge/recebimentosAtoService.js
//
// Recebimentos do Ato (documento AVC) — espelha o relatório do Sienge
// "Contas Recebidas (por Data de Recebimento)" recortado no tipo de documento
// AVC, que é como a entrada/ato entra no contas a receber.
//
// FONTE: API do Sienge AO VIVO — /bulk-data/v1/income com selectionType='P'
// (seleção por data de PAGAMENTO/recebimento).
//
// Por que não é o backup diário: era, e dava diferença. O espelho é restaurado
// ~05h, então um relatório tirado à tarde no Sienge não bate com o nosso. No
// caso medido (empresa 104, 01/08 a 25/08/2026) faltavam 4 baixas / R$ 2.333,73:
// três recebimentos de 25/08 (títulos 32838-32840, criados depois do corte) e um
// de 11/08 lançado retroativamente (título 32650 — o TÍTULO estava no espelho,
// a BAIXA não). Nenhuma era erro de query: era idade do dado.
// Contra a mesma API, o confronto com o PDF fecha exato: 90 baixas,
// R$ 68.261,81, 90 títulos, 90 clientes, e os 15 dias com o mesmo total.
// Mesmo caminho que o landService.js já fez (backup → API) pelo mesmo motivo.
//
// O catálogo de empresas/empreendimentos dos FILTROS continua vindo do backup
// (lib/siengeReadDb.js): é uma lista de nomes que muda devagar, não o número que
// se audita, e evita varrer a API para montar um seletor.
//
// Custo medido: 1 empresa/25 dias ≈ 1s e 245 registros; todas as empresas/3
// meses ≈ 3s e 15.807 registros. Sem paginação — a resposta vem inteira.

import apiSienge from '../../lib/apiSienge.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';

const TIPO_DOCUMENTO = 'AVC';
const ENDPOINT = '/bulk-data/v1/income';

// Whitelist de ordenação (a ordenação agora é em memória, mas a lista mantém a
// tela honesta sobre o que dá para ordenar).
const SORTABLE = new Set([
  'data_baixa', 'cliente', 'data_emissao', 'documento', 'nutitulo',
  'unidade', 'data_vencimento', 'valor_baixa', 'liquido', 'empresa', 'empreendimento',
]);
const DEFAULT_SORT = 'data_baixa';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const n = (v) => Number(v || 0);
// Somar centavos em float acumula resíduo (0,01 somado 90 vezes vira
// ...81000000001). Num relatório que existe para bater com o Sienge, o número
// não pode sair assim do serviço — arredonda ao centavo em toda agregação.
const cents = (v) => Math.round(v * 100) / 100;

/**
 * Normaliza os filtros da query string. Período é obrigatório na prática: sem
 * data o relatório do Sienge não existe, então o default é o mês corrente.
 */
export function normalizeFilters(raw = {}) {
  const toIntArr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map(x => parseInt(x, 10)).filter(Number.isFinite);

  const hoje = new Date();
  const primeiroDia = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
  const hojeISO = hoje.toISOString().slice(0, 10);

  let startDate = DATE_RE.test(raw.startDate) ? raw.startDate : primeiroDia;
  let endDate = DATE_RE.test(raw.endDate) ? raw.endDate : hojeISO;
  // Período invertido devolveria zero linhas calado; corrige em vez de mentir.
  if (startDate > endDate) [startDate, endDate] = [endDate, startDate];

  return {
    startDate,
    endDate,
    empresas: toIntArr(raw.empresas),               // companyId
    empreendimentos: toIntArr(raw.empreendimentos), // costCenterId (centro de custo)
  };
}

/* ── Cache curto da resposta da API ──────────────────────────────────────────
   Só existe para não bater duas vezes na API pelo MESMO recorte quando a tela
   consulta e logo em seguida o usuário exporta o CSV. 60s é desprezível perto
   do problema que essa troca resolve (24h de atraso) e ainda garante que o CSV
   saia idêntico ao que estava na tela. */
const TTL_MS = 60_000;
const _cache = new Map();

function cacheGet(chave) {
  const hit = _cache.get(chave);
  if (hit && Date.now() - hit.t < TTL_MS) return hit;
  if (hit) _cache.delete(chave);
  return null;
}
function cacheSet(chave, v) {
  // Poda preguiçosa: o cache é por recorte, não pode crescer sem fim.
  if (_cache.size > 50) {
    for (const [k, o] of _cache) if (Date.now() - o.t >= TTL_MS) _cache.delete(k);
  }
  _cache.set(chave, { t: Date.now(), v });
}

/**
 * GET respeitando o rate limit do Sienge (200 req/min, COMPARTILHADO com os
 * crons do Office). Sem isto a tela quebrava em produção e funcionava no
 * desenvolvimento: aqui não há cron concorrendo, lá o landService sozinho faz
 * ~154 chamadas por varredura. Um 429 virava exceção e a tela devolvia 500.
 * O erro também passa a sair legível no log — `e.message` de axios só diz
 * "Request failed with status code 429", que não ajuda ninguém às 7h da manhã.
 */
async function getWithRetry(params, tentativas = 3) {
  for (let i = 1; ; i++) {
    try {
      return await apiSienge.get(ENDPOINT, { params });
    } catch (e) {
      const status = e.response?.status;
      const corpo = JSON.stringify(e.response?.data ?? '').slice(0, 300);
      if (status !== 429 || i >= tentativas) {
        console.error(`[recebimentos-ato] Sienge ${status ?? 'sem status'}: ${e.message} ${corpo}`);
        throw e;
      }
      const reset = Number(e.response?.headers?.['ratelimit-reset']) || 5;
      const espera = Math.min(reset + 1, 65) * 1000;
      console.warn(`[recebimentos-ato] rate limit; aguardando ${espera / 1000}s (tentativa ${i}/${tentativas})`);
      await new Promise(r => setTimeout(r, espera));
    }
  }
}

/**
 * Busca as parcelas com recebimento no período direto na API do Sienge.
 * Passa companyId quando há UMA empresa filtrada (a resposta cai de ~5.200 para
 * ~245 registros); com várias, traz tudo e filtra em memória.
 */
async function fetchIncome({ startDate, endDate, companyId = null }) {
  const chave = `${startDate}|${endDate}|${companyId ?? 'all'}`;
  const cached = cacheGet(chave);
  // Devolve o instante da busca REAL, não o de agora: servido do cache, dizer
  // "consultado agora" seria mentira de até 60s num relatório cujo valor é
  // justamente estar atualizado.
  if (cached) return { rows: cached.v, buscadoEm: new Date(cached.t).toISOString(), doCache: true };

  const params = { startDate, endDate, selectionType: 'P' };
  if (companyId) params.companyId = companyId;

  const { data } = await getWithRetry(params);
  const rows = Array.isArray(data?.data) ? data.data : [];
  cacheSet(chave, rows);
  return { rows, buscadoEm: new Date().toISOString(), doCache: false };
}

/** Centro de custo da baixa. Medido: 100% das baixas AVC têm exatamente um. */
function costCenterDaBaixa(bill, receipt) {
  const doMovimento = (receipt.bankMovements || [])
    .flatMap(m => m.financialCategories || [])
    .find(f => f.costCenterId);
  if (doMovimento) {
    return { id: Number(doMovimento.costCenterId), nome: doMovimento.costCenterName || null };
  }
  // Rede de segurança: a categoria também vem repetida no nível do título.
  const doTitulo = (bill.receiptsCategories || []).find(f => f.costCenterId);
  return doTitulo
    ? { id: Number(doTitulo.costCenterId), nome: doTitulo.costCenterName || null }
    : { id: null, nome: null };
}

/**
 * Achata a resposta da API em UMA LINHA POR BAIXA, que é a unidade do relatório
 * (um título pode ser quitado em mais de um recebimento).
 */
function achatar(bills, filtros, scope) {
  const { startDate, endDate } = filtros;
  const filtraEmpresa = filtros.empresas.length ? new Set(filtros.empresas) : null;
  const filtraCC = filtros.empreendimentos.length ? new Set(filtros.empreendimentos) : null;
  const scopeCC = scope.all ? null : new Set(scope.erpIds || []);

  const linhas = [];

  for (const b of bills) {
    if (String(b.documentIdentificationId || '').trim() !== TIPO_DOCUMENTO) continue;
    if (filtraEmpresa && !filtraEmpresa.has(Number(b.companyId))) continue;

    for (const r of (b.receipts || [])) {
      const dataBaixa = String(r.paymentDate || '').slice(0, 10);
      // A API já recorta por data de pagamento, mas um título pode voltar com
      // recebimentos fora da janela; sem este corte o "Total do dia" mostraria
      // um dia que não pertence ao período pedido.
      if (!dataBaixa || dataBaixa < startDate || dataBaixa > endDate) continue;

      const cc = costCenterDaBaixa(b, r);
      const empresaId = Number(b.companyId);
      if (filtraCC && !filtraCC.has(cc.id)) continue;

      // Alçada: fail-closed. Aceita o centro de custo OU o código da empresa
      // porque `enterprises.erp_cost_center_id` guarda ora um, ora outro — o
      // Jardim dos Anjos, por exemplo, tem a linha pareada com o CV em 104 (que
      // é a EMPRESA) e as linhas do ERP em 10401/10402/10490. Comparando só o
      // centro de custo, quem recebesse o grant pela linha do CV via o
      // relatório VAZIO enquanto a conciliação (que já aceitava as duas formas)
      // listava os atos: as duas pontas discordavam sobre o mesmo escopo.
      if (scopeCC && !scopeCC.has(cc.id) && !scopeCC.has(empresaId)) continue;

      const doc = String(b.documentIdentificationId || '').trim();
      const num = String(b.documentNumber || '').trim();

      linhas.push({
        id: `${b.billId}-${b.installmentId}-${r.sequencialNumber ?? 0}`,
        data_baixa: dataBaixa,
        nutitulo: Number(b.billId),
        nuparcela: Number(b.installmentId),
        cod_cliente: Number(b.clientId),
        cliente: (b.clientName || '').trim() || '(sem nome)',
        data_emissao: b.issueDate || null,
        documento: num ? `${doc}.${num}` : doc,
        parcela: b.installmentNumber || String(b.installmentId ?? ''),
        tipo_condicao: (b.paymentTerm?.id || '').trim(),
        unidade: b.mainUnit || null,
        portador: b.bearerId ?? null,
        data_vencimento: b.dueDate || null,
        valor_baixa: n(r.grossAmount),
        acrescimo: n(r.additionAmount),
        seguro: n(r.insuranceAmount),
        taxa_adm: n(r.dueAdmAmount),
        desconto: n(r.discountAmount),
        liquido: n(r.netAmount),
        cod_empresa: Number(b.companyId),
        empresa: (b.companyName || '').trim(),
        cod_empreendimento: cc.id,
        empreendimento: cc.nome,
      });
    }
  }
  return linhas;
}

function ordenar(linhas, sort, dir) {
  const col = SORTABLE.has(sort) ? sort : DEFAULT_SORT;
  const sinal = String(dir).toLowerCase() === 'desc' ? -1 : 1;
  return linhas.sort((a, b) => {
    const x = a[col], y = b[col];
    let c;
    if (typeof x === 'number' && typeof y === 'number') c = x - y;
    else c = String(x ?? '').localeCompare(String(y ?? ''), 'pt-BR');
    // Desempate estável pela ordem do relatório (data, depois título).
    if (c === 0) c = String(a.data_baixa).localeCompare(String(b.data_baixa)) || (a.nutitulo - b.nutitulo);
    return c * sinal;
  });
}

function totalizar(linhas) {
  const soma = (k) => cents(linhas.reduce((s, l) => s + l[k], 0));
  const valor_baixa = soma('valor_baixa');
  return {
    linhas: linhas.length,
    parcelas: linhas.length,
    titulos: new Set(linhas.map(l => l.nutitulo)).size,
    clientes: new Set(linhas.map(l => l.cod_cliente)).size,
    valor_baixa,
    acrescimo: soma('acrescimo'),
    seguro: soma('seguro'),
    taxa_adm: soma('taxa_adm'),
    desconto: soma('desconto'),
    liquido: soma('liquido'),
    valor_medio: linhas.length ? cents(valor_baixa / linhas.length) : 0,
  };
}

function quebraPorDia(linhas) {
  const mapa = new Map();
  for (const l of linhas) {
    const d = mapa.get(l.data_baixa) || { data_baixa: l.data_baixa, parcelas: 0, valor_baixa: 0, liquido: 0 };
    d.parcelas++; d.valor_baixa += l.valor_baixa; d.liquido += l.liquido;
    mapa.set(l.data_baixa, d);
  }
  return [...mapa.values()]
    .map(d => ({ ...d, valor_baixa: cents(d.valor_baixa), liquido: cents(d.liquido) }))
    .sort((a, b) => a.data_baixa.localeCompare(b.data_baixa));
}

/**
 * Opções dos filtros: empresas e empreendimentos que TÊM recebimento de ato.
 * Vem do backup de propósito (ver o cabeçalho): é catálogo, não é o número.
 */
export async function getFilterOptions(scope) {
  const params = [];
  let scopeWhere = '';
  if (!scope.all) {
    params.push(scope.erpIds || []);
    scopeWhere = 'AND e.cdempreendview = ANY($1::int[])';
  }

  const sql = `
    SELECT DISTINCT
      emp.cdempresaview AS cod_empresa, TRIM(emp.nmempresa) AS empresa,
      e.cdempreendview  AS cod_empreendimento, TRIM(e.nmempreend) AS empreendimento
    FROM ecrcbaixa bx
    INNER JOIN ecrctitulo  t   ON t.nutitulo = bx.nutitulo
    INNER JOIN ecadempresa emp ON emp.cdempresa = t.cdempresa
    LEFT JOIN LATERAL (
      SELECT un.cdempreend FROM ecrcunidade un
      WHERE un.nutitulo = t.nutitulo
      ORDER BY (un.flprincipal = 'S') DESC, un.nuunidade LIMIT 1
    ) u ON true
    LEFT JOIN ecadempreend e ON e.cdempreend = u.cdempreend
    WHERE TRIM(t.cddocumento) = '${TIPO_DOCUMENTO}' ${scopeWhere}
  `;
  const { rows } = await siengeQuery(sql, params);

  const empresas = new Map();
  const empreendimentos = new Map();
  for (const r of rows) {
    const ce = Number(r.cod_empresa);
    const cc = Number(r.cod_empreendimento);
    if (Number.isFinite(ce) && !empresas.has(ce)) {
      empresas.set(ce, { id: ce, name: r.empresa || `Empresa ${ce}` });
    }
    if (Number.isFinite(cc) && !empreendimentos.has(cc)) {
      empreendimentos.set(cc, { id: cc, name: r.empreendimento || `CC ${cc}` });
    }
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR');

  return {
    empresas: [...empresas.values()].sort(byName),
    empreendimentos: [...empreendimentos.values()].sort(byName),
  };
}

/** Relatório completo do recorte: totais, quebra por dia e as linhas. */
export async function getReport(filtros, scope, { sort, dir } = {}) {
  // Uma empresa só → deixa a API filtrar (resposta ~20x menor).
  const companyId = filtros.empresas.length === 1 ? filtros.empresas[0] : null;

  // SÓ o período. Já buscou a janela estendida aqui (período + 90 dias de
  // folga) para servir também à conciliação, e foi um erro: sem filtro de
  // empresa a resposta ia de 16 MB para 66,8 MB (20.329 registros) e derrubava
  // a tela em produção com 500. A folga hoje é resolvida no espelho, com uma
  // consulta que devolve nomes (conciliacaoAtoService).
  const { rows: bills, buscadoEm, doCache } = await fetchIncome({ ...filtros, companyId });

  const linhas = ordenar(achatar(bills, filtros, scope), sort, dir);

  return {
    totais: totalizar(linhas),
    porDia: quebraPorDia(linhas),
    linhas,
    filtros,
    // A tela diz de ONDE veio e de QUANDO é o dado. `fonte` existe porque o
    // relatório já morou no backup diário: quem lembra da versão antiga precisa
    // ver escrito que agora é a API.
    fonte: 'api',
    consultadoEm: buscadoEm,
    doCache,
  };
}

export default { normalizeFilters, getFilterOptions, getReport };
