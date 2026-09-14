// services/alerts/AlertReportRenderer.js
//
// Transforma EmeBlock[] (o dado tipado que a tool devolve) no que o alerta
// entrega em cada canal:
//   - renderPreview       linha curta (≤ 120 chars): sino, e-mail, {{3}} do template
//   - renderWhatsAppText  texto formatado do WhatsApp (≤ 3.800 chars)
//
// Fase 2 do plano (_design/ALERTAS-WHATSAPP-PLANO.md) acrescenta aqui o HTML
// do PDF e as abas da planilha, lendo os MESMOS blocos.
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

// ─── Payload do relatório guardado em alert_pending_replies ──────────────────
//
// Desde 14/09/2026 `report_payload` é JSON `{ text, blocks, route }`; antes era
// o texto puro. Lê os dois (mora aqui, e não no handler, para o teste não
// precisar subir o banco).
export function lerPayload(raw) {
    if (raw == null) return { text: '', blocks: [], route: null };
    const s = String(raw);
    if (s.trim().startsWith('{')) {
        try {
            const p = JSON.parse(s);
            if (p && typeof p === 'object' && typeof p.text === 'string') {
                return { text: p.text, blocks: Array.isArray(p.blocks) ? p.blocks : [], route: p.route || null };
            }
        } catch { /* texto que por acaso começa com "{" */ }
    }
    return { text: s, blocks: [], route: null };
}

export default { renderPreview, renderWhatsAppText, formatarValor, numeroDe, lerPayload, LIMITE_TEXTO };
