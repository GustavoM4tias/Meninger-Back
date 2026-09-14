// services/alerts/AlertReportRenderer.js
//
// Transforma EmeBlock[] (o dado tipado que a tool devolve) no que o alerta
// entrega em cada canal:
//   - renderPreview       linha curta (≤ 120 chars): sino, e-mail, {{3}} do template
//   - renderWhatsAppText  texto formatado do WhatsApp (≤ 3.800 chars)
//   - renderHtml          página de papel (entrada do PDF, AlertAttachmentService)
//   - xlsxSheets          abas da planilha (mesmo serviço)
//
// Tudo lê os MESMOS blocos; este módulo é puro (sem banco, sem navegador) e
// por isso é testável em tests/alertRenderer.test.mjs.
//
// Regras:
//   - Número tem tipo: moeda, percentual, data e mês saem no formato que a
//     pessoa lê (formatarValor - espelho de viz/formatos.js do front).
//   - JSON nunca sai: bloco que o renderer não conhece é ignorado; sem bloco
//     nenhum, o texto diz que o resumo não está disponível e aponta a tela.
//   - Corte por bloco inteiro e por linha inteira, nunca no meio de uma linha.
//   - Formatação do WhatsApp: *negrito*, _itálico_, "- " lista, "> " citação.

import dayjs from 'dayjs';
import { blocksDe } from '../OfficeAI/legacyBlocks.js';

export const LIMITE_TEXTO = 3800;
const LINHAS_POR_DATASET = 10;
const CARDS_POR_BLOCO = 8;
const CAMPOS_POR_CARD = 2;
const VALORES_POR_LINHA = 3;

// ─── Formatação por tipo ─────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brlCents = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Número puro de um valor que pode vir formatado ("R$ 3.597.425", "13,5%"). */
export function numeroDe(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    const limpo = s.replace(/[^\d,.-]/g, '');
    if (!limpo || !/\d/.test(limpo)) return null;
    const temVirgula = limpo.includes(',');
    const normal = temVirgula
        ? limpo.replace(/\./g, '').replace(',', '.')
        : limpo.replace(/(\.\d{3})+(?!\d)/g, (m) => m.replace(/\./g, ''));
    const n = Number(normal);
    return Number.isFinite(n) ? n : null;
}

/**
 * Valor → texto pelo tipo da coluna/KPI. `compacto` abrevia milhar e milhão
 * (R$ 1,2 mi) - é o que cabe numa linha de celular.
 */
export function formatarValor(v, tipo = 'text', { compacto = false, unit = null } = {}) {
    if (v == null || v === '') return '-';
    let out;
    switch (tipo) {
        case 'currency': {
            const n = numeroDe(v);
            if (n == null) return String(v);
            if (compacto && Math.abs(n) >= 1_000_000) out = `R$ ${nf1.format(n / 1_000_000)} mi`;
            else if (compacto && Math.abs(n) >= 1_000) out = `R$ ${nf1.format(n / 1_000)} mil`;
            else out = Number.isInteger(n) ? brl.format(n) : brlCents.format(n);
            break;
        }
        case 'number': {
            const n = numeroDe(v);
            if (n == null) return String(v);
            if (compacto && Math.abs(n) >= 1_000_000) out = `${nf1.format(n / 1_000_000)} mi`;
            else if (compacto && Math.abs(n) >= 10_000) out = `${nf1.format(n / 1_000)} mil`;
            else out = Number.isInteger(n) ? nf.format(n) : nf1.format(n);
            break;
        }
        case 'percent': {
            const n = numeroDe(v);
            out = n == null ? String(v) : `${nf1.format(n)}%`;
            break;
        }
        case 'date': {
            const d = dayjs(v);
            out = d.isValid() ? d.format('DD/MM/YYYY') : String(v);
            break;
        }
        case 'month': {
            const m = /^(\d{4})-(\d{2})/.exec(String(v));
            out = m ? `${MESES[Number(m[2]) - 1]}/${m[1].slice(2)}` : String(v);
            break;
        }
        case 'badge':
        case 'link':
        default:
            out = typeof v === 'boolean' ? (v ? 'Sim' : 'Não') : String(v);
    }
    // O Intl põe espaço "duro" (U+00A0) entre R$ e o número; vira espaço comum
    // para o texto do WhatsApp, o HTML e os testes lerem a mesma coisa.
    out = String(out).replace(/[  ]/g, ' ');
    return unit ? `${out} ${unit}` : out;
}

// Espaços em branco não quebram a formatação do WhatsApp; asteriscos soltos sim.
const limparTexto = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const negrito = (s) => `*${limparTexto(s).replace(/\*/g, '')}*`;
const italico = (s) => `_${limparTexto(s).replace(/_/g, '')}_`;

const TIPOS_NUMERICOS = new Set(['number', 'currency', 'percent']);

// ─── Perfil de um dataset: qual coluna é o rótulo, quais são os valores ──────

function perfil(ds) {
    const cols = (ds?.columns || []).map(c => ({ type: 'text', ...c }));
    const porPrioridade = cols.some(c => c.priority != null)
        ? [...cols].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        : cols;
    const rotulo = porPrioridade.find(c => !TIPOS_NUMERICOS.has(c.type) && c.type !== 'date' && c.type !== 'month')
        || porPrioridade.find(c => !TIPOS_NUMERICOS.has(c.type))
        || porPrioridade[0];
    const valores = porPrioridade.filter(c => c !== rotulo).slice(0, VALORES_POR_LINHA);
    return { rotulo, valores };
}

// ─── Blocos → linhas ─────────────────────────────────────────────────────────

function linhasKpis(b) {
    const out = [];
    if (b.title) out.push(`📌 ${negrito(b.title)}`);
    for (const k of b.kpis || []) {
        if (!k || k.value == null || k.value === '') continue;
        const valor = formatarValor(k.value, k.type || 'number', { compacto: true, unit: k.unit });
        const extra = k.hint ? ` ${italico(`(${k.hint})`)}` : '';
        out.push(`▸ ${negrito(k.label || '')} ${valor}${extra}`);
    }
    return out.length > (b.title ? 1 : 0) ? out : [];
}

function linhasDataset(b, { anexoDisponivel } = {}) {
    const ds = b.dataset || {};
    const rows = Array.isArray(ds.rows) ? ds.rows : [];
    const out = [];
    if (b.title) out.push(`📋 ${negrito(b.title)}`);
    const contexto = [b.subtitle, b.source].filter(Boolean).map(limparTexto).join(' · ');
    if (contexto) out.push(`> ${contexto}`);

    const total = ds.total ?? rows.length;
    out.push(`${negrito('Total:')} ${formatarValor(total, 'number')}`);

    if (!rows.length) {
        out.push(italico('Nenhum registro no período.'));
        return out;
    }

    const { rotulo, valores } = perfil(ds);
    // Parte-de-um-todo com UM valor numérico: mostra a fatia de cada linha.
    const colPct = valores.length === 1 && TIPOS_NUMERICOS.has(valores[0].type) && valores[0].type !== 'percent'
        ? valores[0] : null;
    const soma = colPct ? rows.reduce((s, r) => s + (numeroDe(r[colPct.key]) || 0), 0) : 0;

    out.push('');
    for (const r of rows.slice(0, LINHAS_POR_DATASET)) {
        const label = rotulo ? formatarValor(r[rotulo.key], rotulo.type) : '-';
        const vals = valores.map(c => {
            const v = formatarValor(r[c.key], c.type, { compacto: true });
            // Com um valor só o nome da coluna é redundante; com vários, ajuda.
            return valores.length > 1 ? `${limparTexto(c.label)}: ${v}` : v;
        });
        let linha = `- ${negrito(label)}  ${vals.join(' · ')}`;
        if (colPct && soma > 0) {
            const p = Math.round(((numeroDe(r[colPct.key]) || 0) / soma) * 100);
            linha += ` ${italico(`(${p}%)`)}`;
        }
        out.push(linha);
    }

    const restantes = Math.max(0, (Number(total) || rows.length) - Math.min(rows.length, LINHAS_POR_DATASET));
    if (restantes > 0) {
        out.push(italico(anexoDisponivel
            ? `… e mais ${formatarValor(restantes, 'number')} linhas. A planilha completa está em anexo.`
            : `… e mais ${formatarValor(restantes, 'number')} linhas. Abra no Office para ver tudo.`));
    }
    return out;
}

function linhasCards(b) {
    const cards = Array.isArray(b.cards) ? b.cards : [];
    const out = [];
    if (b.title) out.push(`🗂️ ${negrito(b.title)}`);
    if (b.subtitle) out.push(`> ${limparTexto(b.subtitle)}`);
    if (!cards.length) return [];
    out.push('');
    for (const c of cards.slice(0, CARDS_POR_BLOCO)) {
        const campos = (c.fields || []).slice(0, CAMPOS_POR_CARD)
            .map(f => `${limparTexto(f.label)}: ${formatarValor(f.value, f.type || 'text', { compacto: true })}`);
        const cauda = [c.subtitle ? italico(c.subtitle) : null, ...campos].filter(Boolean).join(' · ');
        out.push(`- ${negrito(c.title || '?')}${cauda ? `  ${cauda}` : ''}`);
    }
    if (cards.length > CARDS_POR_BLOCO) out.push(italico(`… e mais ${cards.length - CARDS_POR_BLOCO}.`));
    return out;
}

function linhasDetail(b) {
    const d = b.detail || {};
    const out = [];
    if (b.title) out.push(`📄 ${negrito(b.title)}`);
    if (b.subtitle) out.push(`> ${limparTexto(b.subtitle)}`);
    const campo = (f) => `▸ ${negrito(f.label || '')} ${formatarValor(f.value, f.type || 'text')}`;
    for (const f of d.fields || []) if (f && f.value != null && f.value !== '') out.push(campo(f));
    for (const s of d.sections || []) {
        const linhas = (s.fields || []).filter(f => f && f.value != null && f.value !== '').map(campo);
        if (!linhas.length) continue;
        out.push('');
        if (s.title) out.push(negrito(s.title));
        out.push(...linhas);
    }
    return out.length > (b.title ? 1 : 0) ? out : [];
}

function linhasDoBloco(b, opts) {
    switch (b?.kind) {
        case 'kpis':    return linhasKpis(b);
        case 'dataset': return linhasDataset(b, opts);
        case 'cards':   return linhasCards(b);
        case 'detail':  return linhasDetail(b);
        case 'text':    return b.text ? [limparTexto(b.text)] : [];
        default:        return []; // nav, choice, confirm, legacy, form...
    }
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Linha curta do alerta. Prioridade: KPIs → total do dataset → cards → título.
 */
export function renderPreview(raw, { fallback = 'Relatório disponível' } = {}) {
    if (raw?.error) return `Erro: ${String(raw.error).slice(0, 100)}`;
    const blocks = blocksDe(raw);
    const partes = [];

    const kpis = blocks.find(b => b.kind === 'kpis' && (b.kpis || []).length);
    if (kpis) {
        for (const k of kpis.kpis.slice(0, 3)) {
            if (k?.value == null || k.value === '') continue;
            partes.push(`${limparTexto(k.label)} ${formatarValor(k.value, k.type || 'number', { compacto: true, unit: k.unit })}`);
        }
    }
    if (!partes.length) {
        const ds = blocks.find(b => b.kind === 'dataset');
        if (ds) {
            const rows = ds.dataset?.rows || [];
            const total = ds.dataset?.total ?? rows.length;
            partes.push(`${formatarValor(total, 'number')} ${Number(total) === 1 ? 'registro' : 'registros'}`);
            const { rotulo, valores } = perfil(ds.dataset);
            if (rows[0] && rotulo && valores[0]) {
                partes.push(`top: ${formatarValor(rows[0][rotulo.key], rotulo.type)} (${formatarValor(rows[0][valores[0].key], valores[0].type, { compacto: true })})`);
            }
        }
    }
    if (!partes.length) {
        const cards = blocks.find(b => b.kind === 'cards');
        if (cards) partes.push(`${cards.cards.length} ${cards.cards.length === 1 ? 'item' : 'itens'}`);
    }
    if (!partes.length) {
        const titulo = blocks.find(b => b.title)?.title || raw?.title;
        if (titulo) partes.push(limparTexto(titulo));
    }
    return (partes.join(' · ') || fallback).slice(0, 120);
}

/**
 * Texto do WhatsApp. Cabeçalho com o nome da regra, um bloco por parágrafo,
 * rodapé com o link da tela. Nunca passa de `limite` caracteres.
 *
 * @param {object} raw     retorno da tool (novo ou antigo)
 * @param {object} opts
 * @param {string} opts.ruleName
 * @param {string} [opts.link]            URL absoluta da tela (rodapé)
 * @param {boolean} [opts.anexoDisponivel] muda a frase de corte do dataset
 * @param {number} [opts.limite]
 */
export function renderWhatsAppText(raw, { ruleName, link = null, anexoDisponivel = false, limite = LIMITE_TEXTO } = {}) {
    const head = `📊 ${negrito(ruleName || 'Alerta')}\n━━━━━━━━━━━━━━━`;
    const rodape = link ? `🔗 Abrir no Office: ${link}` : '';

    let corpo;
    if (!raw) {
        corpo = [italico('Sem dados retornados.')];
    } else if (typeof raw === 'string') {
        corpo = [limparTexto(raw)];
    } else if (raw.error) {
        corpo = [`❌ ${limparTexto(raw.error)}`];
    } else if (typeof raw.report_text === 'string') {
        corpo = [String(raw.report_text).trim()];
    } else {
        const blocks = blocksDe(raw);
        const paragrafos = blocks.map(b => linhasDoBloco(b, { anexoDisponivel })).filter(l => l.length);
        corpo = paragrafos.length
            ? paragrafos.map(l => l.join('\n'))
            : [italico('O resumo deste dado ainda não está disponível em texto.') + (link ? ' Abra no Office para ver o relatório.' : '')];
    }

    // Monta respeitando o limite: bloco inteiro cabe ou é substituído pelo aviso.
    const orcamento = limite - head.length - (rodape ? rodape.length + 2 : 0) - 2;
    const partes = [];
    let usado = 0;
    const aviso = italico('… o restante não coube aqui. Abra no Office para ver tudo.');
    for (let i = 0; i < corpo.length; i++) {
        const p = corpo[i];
        const custo = p.length + 2;
        if (usado + custo <= orcamento) { partes.push(p); usado += custo; continue; }
        // Bloco não cabe: tenta cortar por linha inteira, mantendo o aviso.
        const linhas = p.split('\n');
        const cabe = [];
        let parcial = 0;
        for (const l of linhas) {
            if (usado + parcial + l.length + 1 + aviso.length + 2 > orcamento) break;
            cabe.push(l); parcial += l.length + 1;
        }
        if (cabe.length) partes.push(cabe.join('\n'));
        partes.push(aviso);
        break;
    }

    return [head, ...partes, rodape].filter(Boolean).join('\n\n').slice(0, limite);
}

// ─── HTML do PDF (papel) ─────────────────────────────────────────────────────
//
// HTML próprio, sem tokens do design system: é PAPEL, como o `buildPrintHtml`
// das fichas. Mesma leitura do texto, com o dado inteiro: KPIs em cartões,
// gráfico de barras em SVG quando o dataset tem um valor numérico por linha
// e poucas categorias, e a tabela completa.

const LINHAS_POR_TABELA_PDF = 1000;
const BARRAS_MAX = 20;

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const blocksDeEntrada = (entrada) => (Array.isArray(entrada) ? entrada : blocksDe(entrada));

function htmlKpis(b) {
    const itens = (b.kpis || []).filter(k => k && k.value != null && k.value !== '');
    if (!itens.length) return '';
    return `
<section class="bloco">
  ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}
  <div class="kpis">
    ${itens.map(k => `
    <div class="kpi">
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-valor">${esc(formatarValor(k.value, k.type || 'number', { unit: k.unit }))}</div>
      ${k.hint ? `<div class="kpi-hint">${esc(k.hint)}</div>` : ''}
    </div>`).join('')}
  </div>
</section>`;
}

function svgBarras(rows, rotulo, valor) {
    const dados = rows.slice(0, BARRAS_MAX).map(r => ({
        label: formatarValor(r[rotulo.key], rotulo.type),
        n: numeroDe(r[valor.key]) || 0,
    }));
    const max = Math.max(...dados.map(d => Math.abs(d.n)), 1);
    const soma = dados.reduce((s, d) => s + d.n, 0);
    const alturaLinha = 22, largura = 720, colRotulo = 220, colValor = 120;
    const larguraBarra = largura - colRotulo - colValor - 16;
    const altura = dados.length * alturaLinha + 8;
    const linhas = dados.map((d, i) => {
        const y = i * alturaLinha + 4;
        const w = Math.max(2, Math.round((Math.abs(d.n) / max) * larguraBarra));
        const pct = soma > 0 && valor.type !== 'percent' ? ` (${Math.round((d.n / soma) * 100)}%)` : '';
        const rot = d.label.length > 34 ? d.label.slice(0, 33) + '…' : d.label;
        return `
    <text x="${colRotulo - 8}" y="${y + 15}" text-anchor="end" class="rot">${esc(rot)}</text>
    <rect x="${colRotulo}" y="${y + 3}" width="${w}" height="${alturaLinha - 8}" rx="3" class="barra"/>
    <text x="${colRotulo + w + 6}" y="${y + 15}" class="val">${esc(formatarValor(d.n, valor.type, { compacto: true }))}${esc(pct)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${largura} ${altura}" width="100%" class="grafico" role="img" aria-label="${esc(valor.label)} por ${esc(rotulo.label)}">${linhas}</svg>`;
}

function htmlDataset(b) {
    const ds = b.dataset || {};
    const rows = Array.isArray(ds.rows) ? ds.rows : [];
    const cols = (ds.columns || []).map(c => ({ type: 'text', ...c }));
    const total = ds.total ?? rows.length;
    const contexto = [b.subtitle, b.source].filter(Boolean).join(' · ');
    const { rotulo, valores } = perfil(ds);
    const numericas = cols.filter(c => TIPOS_NUMERICOS.has(c.type));
    const grafico = rows.length >= 2 && rows.length <= BARRAS_MAX && rotulo && numericas.length === 1 && valores[0]?.key === numericas[0].key
        ? svgBarras(rows, rotulo, numericas[0]) : '';
    const mostradas = rows.slice(0, LINHAS_POR_TABELA_PDF);
    const cabecalho = cols.map(c => `<th class="${TIPOS_NUMERICOS.has(c.type) ? 'num' : ''}">${esc(c.label)}</th>`).join('');
    const corpo = mostradas.map(r => `<tr>${cols.map(c => `<td class="${TIPOS_NUMERICOS.has(c.type) ? 'num' : ''}">${esc(formatarValor(r[c.key], c.type))}</td>`).join('')}</tr>`).join('\n      ');
    const tabela = rows.length ? `
  <table>
    <thead><tr>${cabecalho}</tr></thead>
    <tbody>
      ${corpo}
    </tbody>
  </table>
  ${rows.length > mostradas.length ? `<p class="nota">Mostrando ${mostradas.length} de ${formatarValor(rows.length, 'number')} linhas.</p>` : ''}
  ${Number(total) > rows.length ? `<p class="nota">A consulta tem ${formatarValor(total, 'number')} registros; aqui estão ${formatarValor(rows.length, 'number')}. Abra no Office para ver tudo.</p>` : ''}`
        : '<p class="nota">Nenhum registro no período.</p>';
    return `
<section class="bloco">
  ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}
  ${contexto ? `<p class="contexto">${esc(contexto)}</p>` : ''}
  <p class="total">Total: <strong>${esc(formatarValor(total, 'number'))}</strong></p>
  ${grafico}
  ${tabela}
</section>`;
}

function htmlCards(b) {
    const cards = Array.isArray(b.cards) ? b.cards : [];
    if (!cards.length) return '';
    const card = (c) => `
    <div class="card">
      <div class="card-titulo">${esc(c.title || '?')}</div>
      ${c.subtitle ? `<div class="card-sub">${esc(c.subtitle)}</div>` : ''}
      ${(c.fields || []).length ? `<dl>${c.fields.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(formatarValor(f.value, f.type || 'text'))}</dd>`).join('')}</dl>` : ''}
    </div>`;
    return `
<section class="bloco">
  ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}
  ${b.subtitle ? `<p class="contexto">${esc(b.subtitle)}</p>` : ''}
  <div class="cards">${cards.map(card).join('')}
  </div>
</section>`;
}

function htmlDetail(b) {
    const d = b.detail || {};
    const vivo = (f) => f && f.value != null && f.value !== '';
    const campo = (f) => `<dt>${esc(f.label)}</dt><dd>${esc(formatarValor(f.value, f.type || 'text'))}</dd>`;
    const fields = (d.fields || []).filter(vivo);
    const sections = (d.sections || []).filter(s => (s.fields || []).some(vivo));
    if (!fields.length && !sections.length) return '';
    return `
<section class="bloco">
  ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}
  ${b.subtitle ? `<p class="contexto">${esc(b.subtitle)}</p>` : ''}
  ${fields.length ? `<dl class="detalhe">${fields.map(campo).join('')}</dl>` : ''}
  ${sections.map(s => `<h3>${esc(s.title || '')}</h3><dl class="detalhe">${s.fields.filter(vivo).map(campo).join('')}</dl>`).join('')}
</section>`;
}

function htmlDoBloco(b) {
    switch (b?.kind) {
        case 'kpis':    return htmlKpis(b);
        case 'dataset': return htmlDataset(b);
        case 'cards':   return htmlCards(b);
        case 'detail':  return htmlDetail(b);
        case 'text':    return b.text ? `<section class="bloco"><p>${esc(b.text)}</p></section>` : '';
        default:        return '';
    }
}

const CSS_PAPEL = `
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Inter, Arial, sans-serif; color: #1c2430; font-size: 11px; line-height: 1.4; }
  header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1c2430; padding-bottom: 8px; margin-bottom: 14px; }
  header .marca { display: flex; align-items: center; gap: 10px; }
  header img { height: 26px; }
  header .eme { font-size: 10px; color: #5b6572; letter-spacing: .08em; text-transform: uppercase; }
  header .meta { text-align: right; font-size: 10px; color: #5b6572; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #5b6572; margin: 0 0 12px; font-size: 11px; }
  h2 { font-size: 13px; margin: 0 0 4px; color: #1c2430; }
  h3 { font-size: 11px; margin: 10px 0 2px; color: #5b6572; text-transform: uppercase; letter-spacing: .06em; }
  .bloco { margin-bottom: 16px; page-break-inside: avoid; }
  .contexto { margin: 0 0 6px; color: #5b6572; }
  .total { margin: 0 0 6px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .kpi { border: 1px solid #d9dee5; border-radius: 6px; padding: 8px 10px; }
  .kpi-label { font-size: 9.5px; color: #5b6572; text-transform: uppercase; letter-spacing: .04em; }
  .kpi-valor { font-size: 16px; font-weight: 600; margin-top: 2px; }
  .kpi-hint { font-size: 9.5px; color: #5b6572; }
  .grafico { margin: 6px 0 10px; }
  .grafico .rot { font-size: 10px; fill: #1c2430; }
  .grafico .val { font-size: 10px; fill: #1c2430; }
  .grafico .barra { fill: #2b5da8; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #e3e7ec; text-align: left; vertical-align: top; }
  th { background: #f2f4f7; font-weight: 600; font-size: 10px; }
  tbody tr:nth-child(even) td { background: #fafbfc; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .nota { color: #5b6572; font-style: italic; margin: 6px 0 0; }
  .erro { color: #a12121; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .card { border: 1px solid #d9dee5; border-radius: 6px; padding: 8px 10px; }
  .card-titulo { font-weight: 600; }
  .card-sub { color: #5b6572; }
  dl { margin: 4px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 1px 8px; }
  dl.detalhe { grid-template-columns: 180px 1fr; }
  dt { color: #5b6572; }
  dd { margin: 0; }
  footer { margin-top: 18px; padding-top: 6px; border-top: 1px solid #d9dee5; font-size: 9.5px; color: #5b6572; display: flex; justify-content: space-between; }
  a { color: #2b5da8; text-decoration: none; }
`;

/**
 * Página HTML do relatório (entrada do PDF).
 *
 * @param {object|EmeBlock[]} entrada  retorno da tool ou blocos
 * @param {object} opts
 * @param {string} opts.ruleName
 * @param {string} [opts.geradoEm]     texto "14/09/2026 08:00"
 * @param {string} [opts.link]         URL da tela no Office (rodapé)
 * @param {string} [opts.logoDataUrl]  data: URL do logo (opcional)
 */
export function renderHtml(entrada, { ruleName, geradoEm = null, link = null, logoDataUrl = null } = {}) {
    const blocks = blocksDeEntrada(entrada);
    const erro = !Array.isArray(entrada) && entrada?.error ? String(entrada.error) : null;
    const corpo = erro
        ? `<section class="bloco"><p class="erro">${esc(erro)}</p></section>`
        : blocks.map(htmlDoBloco).filter(Boolean).join('\n')
            || '<section class="bloco"><p class="nota">O resumo deste dado ainda não está disponível neste formato. Abra no Office para ver o relatório.</p></section>';
    const subtitulo = blocks.find(b => b.subtitle)?.subtitle || '';
    const marca = logoDataUrl ? `<img src="${logoDataUrl}" alt="Menin">` : '<strong>Menin</strong>';

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${esc(ruleName || 'Alerta')}</title>
<style>${CSS_PAPEL}</style>
</head>
<body>
<header>
  <div class="marca">${marca}<span class="eme">Eme · Alertas</span></div>
  <div class="meta">${geradoEm ? `Gerado em ${esc(geradoEm)}` : ''}</div>
</header>
<h1>${esc(ruleName || 'Alerta')}</h1>
${subtitulo ? `<p class="sub">${esc(subtitulo)}</p>` : ''}
${corpo}
<footer>
  <span>Menin Office · relatório gerado automaticamente pela Eme</span>
  ${link ? `<a href="${esc(link)}">${esc(link)}</a>` : ''}
</footer>
</body>
</html>`;
}

// ─── Abas da planilha ────────────────────────────────────────────────────────
//
// Uma aba por dataset (todas as linhas, valor numérico como número) e uma aba
// "Indicadores" com os KPIs. Cards viram uma aba com uma linha por card.

const nomeAba = (s, i) => {
    const base = String(s || `Dados ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28);
    return base || `Dados ${i + 1}`;
};

/**
 * @returns {Array<{ name, columns:[{key,label,type}], rows:object[] }>}
 */
export function xlsxSheets(entrada) {
    const blocks = blocksDeEntrada(entrada);
    const abas = [];
    const usados = new Set();
    const unico = (nome) => {
        let n = nome, i = 2;
        while (usados.has(n)) n = `${nome.slice(0, 25)} ${i++}`;
        usados.add(n);
        return n;
    };

    const kpis = blocks.filter(b => b.kind === 'kpis').flatMap(b => (b.kpis || []).filter(k => k && k.value != null && k.value !== ''));
    if (kpis.length) {
        abas.push({
            name: unico('Indicadores'),
            columns: [
                { key: 'indicador', label: 'Indicador', type: 'text' },
                { key: 'valor', label: 'Valor', type: 'number' },
                { key: 'unidade', label: 'Unidade', type: 'text' },
            ],
            rows: kpis.map(k => ({
                indicador: k.label,
                valor: numeroDe(k.value) ?? k.value,
                unidade: k.unit || (k.type === 'currency' ? 'R$' : k.type === 'percent' ? '%' : ''),
            })),
        });
    }
    blocks.forEach((b, i) => {
        if (b.kind === 'dataset') {
            const ds = b.dataset || {};
            const cols = (ds.columns || []).map(c => ({ type: 'text', ...c }));
            if (!cols.length) return;
            abas.push({ name: unico(nomeAba(b.title, i)), columns: cols, rows: Array.isArray(ds.rows) ? ds.rows : [] });
        } else if (b.kind === 'cards' && (b.cards || []).length) {
            const labels = [];
            for (const c of b.cards) for (const f of c.fields || []) if (!labels.includes(f.label)) labels.push(f.label);
            const columns = [
                { key: 'title', label: 'Título', type: 'text' },
                { key: 'subtitle', label: 'Detalhe', type: 'text' },
                ...labels.map(l => ({ key: `f:${l}`, label: l, type: 'text' })),
            ];
            const rows = b.cards.map(c => {
                const r = { title: c.title, subtitle: c.subtitle || '' };
                for (const f of c.fields || []) r[`f:${f.label}`] = f.value;
                return r;
            });
            abas.push({ name: unico(nomeAba(b.title, i)), columns, rows });
        }
    });
    return abas;
}

/** O texto corta algum dataset? (mais linhas do que o texto mostra, ou total maior que as linhas) */
export function textoCortado(entrada) {
    return blocksDeEntrada(entrada).some(b => b.kind === 'dataset'
        && ((b.dataset?.rows || []).length > LINHAS_POR_DATASET || Number(b.dataset?.total ?? 0) > (b.dataset?.rows || []).length));
}

// ─── Payload do relatório guardado em alert_pending_replies ──────────────────
//
// Desde 14/09/2026 `report_payload` é JSON `{ text, blocks, route, link,
// delivery, xlsxNaResposta, anexoEnviado }`; antes era
// o texto puro. Lê os dois (mora aqui, e não no handler, para o teste não
// precisar subir o banco).
export function lerPayload(raw) {
    const vazio = { text: '', blocks: [], route: null, link: null, delivery: null, xlsxNaResposta: false, anexoEnviado: null };
    if (raw == null) return vazio;
    const s = String(raw);
    if (s.trim().startsWith('{')) {
        try {
            const p = JSON.parse(s);
            if (p && typeof p === 'object' && typeof p.text === 'string') {
                return {
                    ...vazio,
                    text: p.text,
                    blocks: Array.isArray(p.blocks) ? p.blocks : [],
                    route: p.route || null,
                    link: p.link || null,
                    delivery: p.delivery || null,
                    xlsxNaResposta: !!p.xlsxNaResposta,
                    anexoEnviado: p.anexoEnviado || null,
                };
            }
        } catch { /* texto que por acaso começa com "{" */ }
    }
    return { ...vazio, text: s };
}

export default { renderPreview, renderWhatsAppText, renderHtml, xlsxSheets, textoCortado, formatarValor, numeroDe, lerPayload, LIMITE_TEXTO };
