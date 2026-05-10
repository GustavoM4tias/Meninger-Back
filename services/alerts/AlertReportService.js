// services/alerts/AlertReportService.js
//
// Re-executa a tool da Eme gravada em alert_rule.tool_call e produz:
//   - preview: 1 linha pra notificação curta (sino, e-mail, template WhatsApp)
//   - report:  texto completo pra mandar como free-form (segunda mensagem)
//
// O contrato é: dado o mesmo tool_call, sempre devolve a mesma estrutura.
// Datas dinâmicas (ex: "today", "start_of_week") são resolvidas no momento
// do disparo — pra que cada execução tenha contexto temporal correto.

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import db from '../../models/sequelize/index.js';
import { executeTool, TOOLS } from '../OfficeAI/OfficeChatService.js';

dayjs.extend(utc); dayjs.extend(tz); dayjs.extend(isoWeek);

const DEFAULT_TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

// ─── Resolução de placeholders dinâmicos ─────────────────────────────────────

function resolveDynamic(token, timezone = DEFAULT_TZ) {
    const now = dayjs().tz(timezone);
    const fmt = (d) => d.format('YYYY-MM-DD');
    switch (token) {
        case 'today':           return fmt(now);
        case 'yesterday':       return fmt(now.subtract(1, 'day'));
        case 'tomorrow':        return fmt(now.add(1, 'day'));
        case 'start_of_week':   return fmt(now.startOf('isoWeek'));
        case 'end_of_week':     return fmt(now.endOf('isoWeek'));
        case 'start_of_month':  return fmt(now.startOf('month'));
        case 'end_of_month':    return fmt(now.endOf('month'));
        case 'start_of_year':   return fmt(now.startOf('year'));
        case 'last_7_days':     return fmt(now.subtract(7, 'day'));
        case 'last_30_days':    return fmt(now.subtract(30, 'day'));
        default:                return null;
    }
}

/**
 * Percorre args recursivamente substituindo `{ dynamic: 'today' }` pelo valor real.
 * Tudo que não for placeholder fica intacto.
 */
function resolveArgs(args, timezone) {
    if (Array.isArray(args)) return args.map(a => resolveArgs(a, timezone));
    if (args && typeof args === 'object') {
        if (typeof args.dynamic === 'string') {
            const v = resolveDynamic(args.dynamic, timezone);
            return v ?? null;
        }
        const out = {};
        for (const k of Object.keys(args)) out[k] = resolveArgs(args[k], timezone);
        return out;
    }
    return args;
}

// ─── Formatação do resultado ─────────────────────────────────────────────────
//
// Tools da Eme retornam diferentes shapes:
//   - chart  → { type:'chart', title, labels:[], data:[], rawRows:[{label,total}], context }
//   - table  → { type:'table', title, columns:[], rows:[], total, context }
//   - detail → { type:'detail', title, fields:[], context }
//   - texto/objeto livre → string ou {summary, message, totals/kpis, items/data/rows}
//
// Os helpers abaixo lidam com cada caso e produzem texto legível pro WhatsApp.

function fmtNum(n) {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    return num.toLocaleString('pt-BR');
}

function pct(part, total) {
    if (!total) return 0;
    return Math.round((Number(part || 0) / total) * 100);
}

// Identifica a "key" de uma coluna (suporta {field}, {key}, {accessor} ou string)
function colKey(c)   { return typeof c === 'string' ? c : (c?.field || c?.key || c?.accessor || c?.label); }
function colLabel(c) { return typeof c === 'string' ? c : (c?.label || c?.title || c?.name || colKey(c)); }

/**
 * Preview de 1 linha — vai pra notificação curta e pro template WhatsApp ({{3}}).
 */
function buildPreview(result, fallbackTitle) {
    if (!result || typeof result !== 'object') return fallbackTitle || 'Relatório disponível';
    if (result.error) return `Erro: ${String(result.error).slice(0, 100)}`;

    // chart: total + top categoria
    if (result.type === 'chart' && Array.isArray(result.data)) {
        const total = result.data.reduce((s, n) => s + Number(n || 0), 0);
        const top   = result.labels?.[0] && result.data?.[0]
            ? `top: ${result.labels[0]} (${fmtNum(result.data[0])})`
            : '';
        const word = total === 1 ? 'registro' : 'registros';
        return [`${fmtNum(total)} ${word}`, top].filter(Boolean).join(' · ').slice(0, 120);
    }

    // table: total
    if (result.type === 'table') {
        const total = result.total ?? (result.rows || []).length;
        const word  = total === 1 ? 'registro' : 'registros';
        return `${fmtNum(total)} ${word}`;
    }

    // summary: extrai 1-3 KPIs
    const totals = result.totals || result.kpis || result.stats || result.summary_data;
    if (totals && typeof totals === 'object') {
        const parts = Object.entries(totals).slice(0, 3).map(([k, v]) => `${k}: ${fmtNum(v)}`);
        return parts.join(' · ').slice(0, 120);
    }

    if (typeof result.summary === 'string') return result.summary.slice(0, 120);
    if (typeof result.message === 'string') return result.message.slice(0, 120);

    const list = result.items || result.data || result.rows;
    if (Array.isArray(list)) return `${fmtNum(list.length)} ${list.length === 1 ? 'registro' : 'registros'}`;

    return fallbackTitle || 'Relatório disponível';
}

/**
 * Relatório completo em markdown WhatsApp — multilinhas, com totais, top items
 * e percentuais quando aplicável.
 */
function buildReport(result, ruleName) {
    const head = `📊 *${ruleName}*\n\n`;

    if (!result)                   return head + '_Sem dados retornados._';
    if (typeof result === 'string') return (head + result).slice(0, 3800);
    if (result.error)               return head + `❌ ${result.error}`;
    if (typeof result.report_text === 'string') return (head + result.report_text).slice(0, 3800);

    const lines = [];

    // ── CHART (group_by) ────────────────────────────────────────────────────
    if (result.type === 'chart' && Array.isArray(result.labels) && Array.isArray(result.data)) {
        if (result.title) lines.push(`*${result.title}*`);

        // Pares label-value, ordenados decrescente
        const pairs = result.labels
            .map((label, i) => ({ label: label || 'Não informado', value: Number(result.data[i] || 0) }))
            .filter(p => p.value > 0)
            .sort((a, b) => b.value - a.value);

        const total = pairs.reduce((s, p) => s + p.value, 0);
        if (total === 0) {
            lines.push('');
            lines.push('_Nenhum registro no período._');
        } else {
            lines.push(`*Total:* ${fmtNum(total)}`);
            lines.push('');
            const top = pairs.slice(0, 10);
            for (const p of top) {
                lines.push(`• *${p.label}*: ${fmtNum(p.value)} _(${pct(p.value, total)}%)_`);
            }
            if (pairs.length > 10) lines.push(`_... e mais ${pairs.length - 10} categorias_`);
        }
        return (head + lines.join('\n')).slice(0, 3800);
    }

    // ── TABLE ────────────────────────────────────────────────────────────────
    if (result.type === 'table') {
        if (result.title) lines.push(`*${result.title}*`);

        const rows  = Array.isArray(result.rows) ? result.rows : [];
        const cols  = Array.isArray(result.columns) ? result.columns : [];
        const total = result.total ?? rows.length;

        lines.push(`*Total:* ${fmtNum(total)}`);
        lines.push('');

        if (rows.length === 0) {
            lines.push('_Nenhum registro encontrado._');
        } else {
            // 1ª col = título do item; até mais 2 cols viram metadata
            const main = cols[0];
            const extras = cols.slice(1, 3);

            const showRows = rows.slice(0, 8);
            for (const row of showRows) {
                const k = colKey(main);
                const label = (k && row[k]) || row.name || row.title || row.label || '?';
                const meta = extras
                    .map(c => {
                        const ck = colKey(c);
                        const v = ck ? row[ck] : null;
                        if (v === null || v === undefined || v === '') return null;
                        return `${colLabel(c)}: ${v}`;
                    })
                    .filter(Boolean)
                    .join(' · ');
                lines.push(meta ? `• *${label}*\n  _${meta}_` : `• ${label}`);
            }
            if (rows.length > showRows.length) {
                lines.push(`\n_... e mais ${rows.length - showRows.length}_`);
            }
        }
        return (head + lines.join('\n')).slice(0, 3800);
    }

    // ── DETAIL (ex: get_enterprise_detail) ─────────────────────────────────
    if (result.type === 'detail') {
        if (result.title) lines.push(`*${result.title}*\n`);
        const fields = result.fields || [];
        for (const f of fields) {
            const label = f.label || f.key || '';
            const value = f.value;
            if (value === null || value === undefined || value === '') continue;
            lines.push(`*${label}:* ${value}`);
        }
        return (head + lines.join('\n')).slice(0, 3800);
    }

    // ── SUMMARY / KPIs (sem type explícito) ─────────────────────────────────
    if (typeof result.summary === 'string') lines.push(result.summary);
    if (typeof result.message === 'string') lines.push(result.message);

    const totals = result.totals || result.kpis || result.stats || result.summary_data;
    if (totals && typeof totals === 'object') {
        if (lines.length) lines.push('');
        lines.push('*Indicadores:*');
        for (const [k, v] of Object.entries(totals)) {
            lines.push(`• *${k}:* ${fmtNum(v)}`);
        }
    }

    const list = result.items || result.data || result.rows;
    if (Array.isArray(list) && list.length) {
        if (lines.length) lines.push('');
        lines.push(`*Itens (${Math.min(list.length, 8)} de ${list.length}):*`);
        for (const item of list.slice(0, 8)) {
            if (typeof item === 'string' || typeof item === 'number') {
                lines.push(`• ${item}`);
            } else if (item && typeof item === 'object') {
                const label = item.name || item.title || item.label || item.nome || '?';
                const value = item.count ?? item.total ?? item.value ?? item.qtd ?? '';
                lines.push(`• ${label}${value !== '' ? ` — *${fmtNum(value)}*` : ''}`);
            }
        }
        if (list.length > 8) lines.push(`_... e mais ${list.length - 8}_`);
    }

    if (!lines.length) {
        // fallback: JSON resumido só pra debug — não deveria acontecer no fluxo normal
        lines.push('_Formato de retorno não reconhecido._');
        lines.push('```');
        lines.push(JSON.stringify(result, null, 2).slice(0, 800));
        lines.push('```');
    }

    return (head + lines.join('\n')).slice(0, 3800);
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Executa o tool_call de uma rule e retorna { preview, report, raw }.
 *
 * @param {object} rule   - AlertRule com tool_call, name, timezone
 * @param {object} user   - User dono da regra (pra contexto/permissão das tools)
 */
async function execute(rule, user) {
    const toolCall = rule.tool_call || {};
    const name = toolCall.tool;
    if (!name || !TOOLS.has(name)) {
        return {
            preview: 'Tool não encontrada',
            report:  `❌ A ferramenta "${name}" não existe ou foi removida. Edite o alerta.`,
            raw:     { error: `Tool "${name}" não registrada` },
        };
    }

    const resolvedArgs = resolveArgs(toolCall.args || {}, rule.timezone || DEFAULT_TZ);

    try {
        const raw = await executeTool(name, resolvedArgs, user);
        return {
            preview: buildPreview(raw, rule.name),
            report:  buildReport(raw, rule.name),
            raw,
            // tool_call com placeholders já resolvidos — usado pra montar links
            resolvedToolCall: { tool: name, args: resolvedArgs },
        };
    } catch (err) {
        console.error(`[AlertReportService] tool ${name} falhou:`, err);
        return {
            preview: 'Erro ao gerar relatório',
            report:  `❌ Erro ao executar "${name}": ${err.message}`,
            raw:     { error: err.message },
            resolvedToolCall: { tool: name, args: resolvedArgs },
        };
    }
}

/**
 * Executa pra preview na criação (Eme chama isso antes de salvar a regra
 * pra mostrar ao user um exemplo do que ele vai receber).
 */
async function preview(toolCall, user, timezone = DEFAULT_TZ) {
    return execute({ tool_call: toolCall, name: 'Preview', timezone }, user);
}

export default {
    execute,
    preview,
    resolveDynamic,
    resolveArgs,
};
