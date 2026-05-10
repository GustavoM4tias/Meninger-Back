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

/**
 * Tenta extrair uma "1 linha" do resultado da tool, pra usar no template do
 * WhatsApp (que aceita pouco espaço).
 *
 * Estratégia: olha campos comuns. Se a tool retorna { summary }, usa.
 * Caso contrário, conta itens (.items, .data, .rows).
 */
function buildPreview(result, fallbackTitle) {
    if (!result || typeof result !== 'object') return fallbackTitle || 'Relatório disponível';
    if (typeof result.summary === 'string')      return result.summary.slice(0, 120);
    if (typeof result.message === 'string')      return result.message.slice(0, 120);

    const totals = result.totals || result.kpis || result.stats;
    if (totals && typeof totals === 'object') {
        const parts = Object.entries(totals).slice(0, 3).map(([k, v]) => `${k}: ${v}`);
        return parts.join(' · ').slice(0, 120);
    }

    const list = result.items || result.data || result.rows;
    if (Array.isArray(list)) return `${list.length} ${list.length === 1 ? 'registro' : 'registros'}`;

    return fallbackTitle || 'Relatório disponível';
}

/**
 * Constrói o "relatório completo" em texto plano (multiplas linhas) que vai pro WhatsApp.
 * - Se a tool já devolve `report_text`, usa direto.
 * - Caso contrário, serializa de forma legível.
 */
function buildReport(result, ruleName) {
    const head = `📊 *${ruleName}*\n\n`;

    if (!result) return head + '_Sem dados retornados._';
    if (result.error)               return head + `_Erro: ${result.error}_`;
    if (typeof result === 'string') return head + result.slice(0, 3500);
    if (typeof result.report_text === 'string') return head + result.report_text.slice(0, 3500);

    const lines = [];

    if (result.summary)       lines.push(result.summary);
    if (result.message)       lines.push(result.message);

    const totals = result.totals || result.kpis || result.stats;
    if (totals && typeof totals === 'object') {
        lines.push('');
        for (const [k, v] of Object.entries(totals)) lines.push(`• *${k}*: ${v}`);
    }

    const list = result.items || result.data || result.rows;
    if (Array.isArray(list) && list.length) {
        lines.push('');
        lines.push(`*Itens (${Math.min(list.length, 10)} de ${list.length}):*`);
        for (const item of list.slice(0, 10)) {
            if (typeof item === 'string') {
                lines.push(`• ${item}`);
            } else {
                const label = item.name || item.title || item.label || JSON.stringify(item).slice(0, 80);
                const value = item.count ?? item.total ?? item.value ?? '';
                lines.push(`• ${label}${value !== '' ? ` — ${value}` : ''}`);
            }
        }
        if (list.length > 10) lines.push(`_... e mais ${list.length - 10}_`);
    }

    if (!lines.length) {
        // fallback: JSON resumido
        lines.push('```');
        lines.push(JSON.stringify(result, null, 2).slice(0, 1500));
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
        };
    } catch (err) {
        console.error(`[AlertReportService] tool ${name} falhou:`, err);
        return {
            preview: 'Erro ao gerar relatório',
            report:  `❌ Erro ao executar "${name}": ${err.message}`,
            raw:     { error: err.message },
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
