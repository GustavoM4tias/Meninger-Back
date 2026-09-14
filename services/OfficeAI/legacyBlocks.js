// services/OfficeAI/legacyBlocks.js
//
// Traduz o retorno ANTIGO de uma tool (um `type` por tool: `table`, `chart`,
// `detail`, `reservas_summary`, `*_cards`...) para EmeBlock[] (blocks.js).
//
// É a porta do `viz/legacyAdapter.js` do front para o servidor: alertas
// (texto do WhatsApp, PDF, planilha) e relatórios precisam do MESMO dado
// tipado que o chat já lê, e só 4 tools devolvem `blocks` até 14/09/2026.
// Cada tool migrada na fase 4 do plano da galeria deixa de passar por aqui;
// quando a última migrar, este arquivo some.
//
// Regras:
//   - `message` NUNCA vira bloco: é instrução para o modelo ("responda curto
//     usando somente estes números"), não texto para a pessoa.
//   - Forma que nem o adaptador conhece devolve [] - quem renderiza decide o
//     que dizer. JSON cru não sai daqui.
//   - Valor vai cru; o tipo da coluna/KPI diz como formatar.

import { datasetBlock, kpisBlock, cardsBlock, detailBlock } from './blocks.js';

// ─── Sumários com chave conhecida (label + tipo explícitos) ──────────────────
//
// `dias` e `pct` viram `unit`/`type` do KPI. A ordem aqui é a ordem no texto.

const SUMMARY_KPIS = {
    reservas_summary: [
        ['total',                    'Reservas',                 'number'],
        ['ativas',                   'Ativas',                   'number'],
        ['reservada',                'Em reserva',               'number'],
        ['contrato',                 'Em contrato',              'number'],
        ['em_repasse',               'Em repasse',               'number'],
        ['vendida',                  'Vendidas (etapa do CRM)',  'number'],
        ['cancelada',                'Canceladas',               'number'],
        ['outros',                   'Outras etapas',            'number'],
        ['taxa_venda',               'Taxa de venda',            'percent'],
        ['taxa_distrato',            'Taxa de distrato',         'percent'],
        ['tempo_medio_em_reserva',   'Tempo médio em reserva',   'number', 'dias'],
        ['tempo_medio_ate_venda',    'Tempo médio até a venda',  'number', 'dias'],
        ['tempo_medio_ate_contrato', 'Tempo médio até contrato', 'number', 'dias'],
    ],
    precadastros_summary: [
        ['total',                  'Pré-cadastros',            'number'],
        ['em_analise',             'Em análise',               'number'],
        ['documentacao',           'Em documentação',          'number'],
        ['aprovados',              'Aprovados',                'number'],
        ['aprovado_sem_reserva',   'Aprovados sem reserva',    'number'],
        ['reserva',                'Viraram reserva',          'number'],
        ['reprovado',              'Reprovados',               'number'],
        ['pendentes',              'Pendentes',                'number'],
        ['outros',                 'Outras situações',         'number'],
        ['taxa_aprovacao',         'Taxa de aprovação',        'percent'],
        ['taxa_conv_reserva',      'Conversão em reserva',     'percent'],
        ['taxa_reprovacao',        'Taxa de reprovação',       'percent'],
        ['tempo_medio_em_analise', 'Tempo médio em análise',   'number', 'dias'],
        ['tempo_medio_finalizar',  'Tempo médio para concluir','number', 'dias'],
    ],
    repasses_summary: [
        ['total',                'Repasses',                 'number'],
        ['reservas',             'Reservas',                 'number'],
        ['contratos_quitados',   'Contratos quitados',       'number'],
        ['em_analise_contratos', 'Em análise de contratos',  'number'],
        ['valor_financiado',     'Valor financiado',         'currency'],
        ['valor_previsto',       'Valor previsto',           'currency'],
        ['valor_subsidio',       'Subsídio',                 'currency'],
        ['valor_fgts',           'FGTS',                     'currency'],
        ['sla_medio_dias',       'SLA médio',                'number', 'dias'],
    ],
};

// Chaves que são envelope/controle, nunca dado para a pessoa.
const CHAVES_DE_CONTROLE = new Set([
    'type', 'source', 'context', 'message', 'error', 'screenLink', 'title', 'subtitle',
    'chartType', 'focus', 'kind', 'blocks', 'precisa_desambiguar', 'candidatos',
    'rawRows', 'labels', 'data', 'top_breakdown', 'columns', 'rows', 'fields',
    'valueLabel', 'valueType', 'fonte', 'resultCount', 'link', 'icon', 'tone', 'version',
]);

// ─── Inferência de tipo pelo nome da chave / valor ───────────────────────────

const RE_MOEDA    = /(^|_)(valor|vgv|preco|custo|receita|total_pago|saldo|financiado|subsidio|fgts|comissao|desconto|ticket)(_|$)|(^|_)r\$/i;
const RE_PERCENT  = /(^|_)(taxa|pct|percent|percentual|participacao|conversao|share)(_|$)/i;
const RE_DATA     = /(^|_)(data|date|vencimento|emissao|pagamento|criado|atualizado|inicio|fim|entrega|prazo)(_|$)|_at$|_em$/i;
// Identificador: nunca leva separador de milhar nem vira KPI.
const RE_ID       = /(^|_)(id|ids|uuid|token|hash)(_|$)|^id[a-z_]*$|_id$|^(reserva|contrato|codigo|cod|numero|num|matricula|cpf|cnpj|telefone|fone|cep|unidade)$/i;
const RE_ISO_DATA = /^\d{4}-\d{2}-\d{2}/;
const RE_MES      = /^\d{4}-\d{2}$/;

function ehEscalar(v) {
    return v == null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** Tipo de coluna para uma chave, olhando o nome e uma amostra de valor. */
export function inferirTipo(key, amostra) {
    const k = String(key || '');
    if (RE_ID.test(k)) return 'text';
    if (typeof amostra === 'string' && RE_MES.test(amostra)) return 'month';
    if (RE_DATA.test(k) || (typeof amostra === 'string' && RE_ISO_DATA.test(amostra))) return 'date';
    if (RE_PERCENT.test(k)) return 'percent';
    if (RE_MOEDA.test(k)) return 'currency';
    if (typeof amostra === 'number') return 'number';
    if (typeof amostra === 'string' && /^R\$\s?[\d.,]+$/.test(amostra.trim())) return 'currency';
    if (typeof amostra === 'string' && /^[\d.,]+%$/.test(amostra.trim())) return 'percent';
    return 'text';
}

/** "valor_financiado" → "Valor financiado"; "vgv" → "VGV". */
export function humanizar(key) {
    const s = String(key || '').replace(/[_-]+/g, ' ').trim();
    if (!s) return '';
    if (/^(vgv|cca|dc|sla|cpf|cnpj|id)$/i.test(s)) return s.toUpperCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Título/subtítulo/label dizendo que o número é dinheiro.
const looksMoney = (a) => /R\$|\bvgv\b|valor|receita|custo|faturamento/i.test(
    [a.valueLabel, a.title, a.subtitle].filter(Boolean).join(' ')
);

// ─── Conversores por forma ───────────────────────────────────────────────────

function colunaDe(c, amostraRow) {
    if (typeof c === 'string') return { key: c, label: humanizar(c), type: inferirTipo(c, amostraRow?.[c]) };
    const key = c?.key || c?.field || c?.accessor || c?.label;
    if (!key) return null;
    return {
        key,
        label: c.label || c.title || c.name || humanizar(key),
        type: c.type || inferirTipo(key, amostraRow?.[key]),
        ...(c.priority != null ? { priority: c.priority } : {}),
    };
}

/** Colunas inferidas da união das chaves escalares das primeiras linhas. */
function colunasDasLinhas(rows) {
    const chaves = [];
    for (const r of rows.slice(0, 20)) {
        if (!r || typeof r !== 'object') continue;
        for (const k of Object.keys(r)) {
            if (!chaves.includes(k) && ehEscalar(r[k]) && !CHAVES_DE_CONTROLE.has(k)) chaves.push(k);
        }
    }
    const amostra = rows.find(r => r && typeof r === 'object') || {};
    return chaves.map(k => ({ key: k, label: humanizar(k), type: inferirTipo(k, amostra[k]) }));
}

function tabelaParaBlocks(a) {
    const rows = Array.isArray(a.rows) ? a.rows : [];
    const declaradas = Array.isArray(a.columns) ? a.columns.map(c => colunaDe(c, rows[0])).filter(Boolean) : [];
    const columns = declaradas.length ? declaradas : colunasDasLinhas(rows);
    return [datasetBlock({
        title: a.title, subtitle: a.subtitle, source: a.source,
        visual: 'table',
        columns, rows,
        total: a.total ?? rows.length,
        truncated: !!a.truncated || (a.total != null && Number(a.total) > rows.length),
    })];
}

function graficoParaBlocks(a) {
    const labels = Array.isArray(a.labels) ? a.labels : [];
    const data   = Array.isArray(a.data) ? a.data : [];
    const tipoValor = a.valueType || (looksMoney(a) ? 'currency' : 'number');
    const rows = labels.map((l, i) => ({ label: l ?? 'Não informado', value: Number(data[i] ?? 0) }));
    const out = [];

    // Números de cabeçalho que algumas tools põem soltos ao lado do gráfico
    // (vendas consolidadas: vendas, vgv, vgv_mais_dc...).
    const kpis = kpisSoltos(a);
    if (kpis.length) out.push(kpisBlock({ inline: true, kpis }));

    out.push(datasetBlock({
        title: a.title, subtitle: a.subtitle, source: a.source,
        visual: a.chartType === 'pie' ? 'donut' : 'bar',
        columns: [
            { key: 'label', label: 'Categoria', type: 'text' },
            { key: 'value', label: a.valueLabel || 'Total', type: tipoValor },
        ],
        rows,
        total: rows.length,
        parteDeUmTodo: a.chartType === 'pie' ? true : undefined,
    }));
    return out;
}

/** Escalares numéricos soltos no objeto (fora do envelope) viram KPIs. */
function kpisSoltos(a) {
    const kpis = [];
    for (const [k, v] of Object.entries(a)) {
        if (CHAVES_DE_CONTROLE.has(k) || RE_ID.test(k)) continue;
        if (typeof v === 'boolean' || v == null || v === '') continue;
        const tipo = inferirTipo(k, v);
        const numerico = typeof v === 'number' || tipo === 'currency' || tipo === 'percent';
        if (!numerico) continue;
        kpis.push({ label: humanizar(k), value: v, type: tipo });
    }
    return kpis.slice(0, 8);
}

function sumarioParaBlocks(a, mapa) {
    const kpis = [];
    for (const [key, label, type, unit] of mapa) {
        const v = a[key];
        if (v == null || v === '') continue;
        kpis.push({ label, value: v, type, ...(unit ? { unit } : {}) });
    }
    return kpis.length ? [kpisBlock({ title: a.title, kpis, inline: false })] : [];
}

function detalheParaBlocks(a) {
    const fields = [];
    const sections = [];
    if (Array.isArray(a.fields)) {
        for (const f of a.fields) {
            if (!f || f.value == null || f.value === '') continue;
            fields.push({ label: f.label || humanizar(f.key), value: f.value, type: f.type || inferirTipo(f.key || f.label, f.value) });
        }
    } else {
        for (const [k, v] of Object.entries(a)) {
            if (CHAVES_DE_CONTROLE.has(k) || v == null || v === '') continue;
            if (ehEscalar(v)) {
                if (RE_ID.test(k)) continue;
                fields.push({ label: humanizar(k), value: v, type: inferirTipo(k, v) });
            } else if (!Array.isArray(v) && typeof v === 'object') {
                const sub = Object.entries(v)
                    .filter(([sk, sv]) => ehEscalar(sv) && sv != null && sv !== '' && !RE_ID.test(sk))
                    .map(([sk, sv]) => ({ label: humanizar(sk), value: sv, type: inferirTipo(sk, sv) }));
                if (sub.length) sections.push({ title: humanizar(k), fields: sub });
            }
        }
    }
    if (!fields.length && !sections.length) return [];
    return [detailBlock({ title: a.title || a.nome || a.name, subtitle: a.subtitle, detail: { fields, sections } })];
}

// Cards: qualquer lista de objetos com título. Campos escalares viram `fields`.
function cardsParaBlocks(a, lista) {
    const cards = lista
        .filter(c => c && typeof c === 'object')
        .map(c => {
            const title = c.title || c.name || c.nome || c.label || c.titulo || '?';
            const subtitle = c.subtitle || c.empreendimento || c.category || c.categoria || c.status || undefined;
            const fields = Object.entries(c)
                .filter(([k, v]) => ehEscalar(v) && v != null && v !== '' && !RE_ID.test(k)
                    && !['title', 'name', 'nome', 'label', 'titulo', 'subtitle', 'empreendimento', 'category', 'categoria', 'status', 'kind', 'link', 'icon', 'tone'].includes(k))
                .map(([k, v]) => ({ label: humanizar(k), value: v, type: inferirTipo(k, v) }));
            // Progresso do checklist: { total, done, pct, overdue } é o dado que interessa.
            if (c.progresso && typeof c.progresso === 'object') {
                fields.unshift({ label: 'Concluídas', value: `${c.progresso.done ?? 0}/${c.progresso.total ?? 0}`, type: 'text' });
                if (c.progresso.overdue) fields.push({ label: 'Atrasadas', value: c.progresso.overdue, type: 'number' });
            }
            return { title, subtitle, fields };
        });
    return cards.length ? [cardsBlock({ title: a.title, subtitle: a.subtitle, cards })] : [];
}

// Lista genérica de objetos (items/data/rows/planos/mudancas...) → dataset.
function listaParaBlocks(a, lista, chave) {
    const rows = lista.filter(r => r && typeof r === 'object');
    if (!rows.length) return [];
    const columns = colunasDasLinhas(rows);
    if (!columns.length) return [];
    return [datasetBlock({
        title: a.title || humanizar(chave), subtitle: a.subtitle, source: a.source,
        visual: 'table', columns, rows, total: a.total ?? rows.length,
    })];
}

// ─── Porta de entrada ────────────────────────────────────────────────────────

/**
 * Retorno antigo de uma tool → EmeBlock[]. Vazio quando não reconhece.
 */
export function legacyToBlocks(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return [];
    if (a.error) return [];

    if (a.type === 'table')  return tabelaParaBlocks(a);
    if (a.type === 'chart')  return graficoParaBlocks(a);
    if (a.type === 'detail') return detalheParaBlocks(a);
    if (SUMMARY_KPIS[a.type]) return sumarioParaBlocks(a, SUMMARY_KPIS[a.type]);

    if (typeof a.type === 'string' && /_cards?$|_tasks$/.test(a.type)) {
        const lista = a.cards || a.items || a.campanhas || a.tasks || a.checklists || [];
        if (Array.isArray(lista) && lista.length) return cardsParaBlocks(a, lista);
    }

    // Sem `type` conhecido: totais/kpis explícitos + primeira lista de objetos.
    const out = [];
    const totals = a.totals || a.kpis || a.stats || a.summary_data;
    if (totals && typeof totals === 'object' && !Array.isArray(totals)) {
        const kpis = Object.entries(totals)
            .filter(([, v]) => ehEscalar(v) && v != null && v !== '')
            .map(([k, v]) => ({ label: humanizar(k), value: v, type: inferirTipo(k, v) }));
        if (kpis.length) out.push(kpisBlock({ title: a.title, kpis, inline: false }));
    } else {
        const kpis = kpisSoltos(a);
        if (kpis.length) out.push(kpisBlock({ title: a.title, kpis, inline: false }));
    }
    for (const chave of ['items', 'data', 'rows', 'lista', 'planos', 'mudancas', 'results', 'registros']) {
        if (Array.isArray(a[chave]) && a[chave].length) {
            out.push(...listaParaBlocks(a, a[chave], chave));
            break;
        }
    }
    if (!out.length) {
        // Qualquer outro array de objetos no primeiro nível.
        for (const [k, v] of Object.entries(a)) {
            if (CHAVES_DE_CONTROLE.has(k) || !Array.isArray(v) || !v.length) continue;
            const blocos = listaParaBlocks(a, v, k);
            if (blocos.length) { out.push(...blocos); break; }
        }
    }
    return out;
}

/**
 * Blocos de um retorno, venha ele novo (`blocks[]`) ou antigo (`type`).
 * É a única porta que alerta, PDF e planilha usam.
 */
export function blocksDe(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (Array.isArray(raw.blocks) && raw.blocks.length) return raw.blocks.filter(b => b && typeof b === 'object');
    return legacyToBlocks(raw);
}

export default { legacyToBlocks, blocksDe, inferirTipo, humanizar };
