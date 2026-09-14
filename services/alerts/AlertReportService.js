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
import { executeTool, TOOLS, legacyToolAllowed } from '../OfficeAI/OfficeChatService.js';
import { findTool, userHasPermissions } from '../OfficeAI/ToolRegistry.js';
import { runTool as runSecureTool } from '../OfficeAI/SecureRunner.js';
import { blocksDe } from '../OfficeAI/legacyBlocks.js';
import { renderPreview, renderWhatsAppText } from './AlertReportRenderer.js';
import { toolToRoute } from './toolToRoute.js';
import { urlDeEnv } from '../../utils/envUrl.js';

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
// O retorno da tool (novo, com `blocks`, ou antigo, com `type`) vira texto no
// AlertReportRenderer: `legacyBlocks.js` traduz o formato antigo para EmeBlock
// e o renderer formata cada bloco pelo tipo do dado. Antes de 14/09/2026 este
// arquivo adivinhava a forma (4 shapes) e caía em JSON cru para o resto.

/** URL absoluta da tela do dado, para o rodapé do texto e o botão do template. */
function linkAbsoluto(route) {
    if (!route) return null;
    return `${urlDeEnv('FRONTEND_URL', 'https://office.menin.com.br')}${route.startsWith('/') ? '' : '/'}${route}`;
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Executa o tool_call de uma rule e retorna { preview, report, raw }.
 *
 * @param {object} rule   - AlertRule com tool_call, name, timezone
 * @param {object} user   - User dono da regra (pra contexto/permissão das tools)
 */
// ─── Qual tool, de qual família ──────────────────────────────────────────────
// A Eme tem duas famílias: o ToolRegistry (SecureRunner: permissão + audit) e
// o mapa legado do OfficeChatService (Marketing/Comercial/Fichas/Alertas).
// Até 11/09/2026 o alerta só enxergava o mapa legado: das 81 tools, 63 não
// podiam virar alerta - boletos, custos, faturamento, projeção, checklists...
// existiam no chat e "não existiam" aqui.
function resolveTool(name) {
    const reg = findTool(name);
    if (reg) return { kind: 'registry', tool: reg };
    if (TOOLS.has(name)) return { kind: 'legacy', declaration: TOOLS.get(name).declaration };
    return null;
}

/**
 * A receita existe e o DONO do alerta pode rodá-la?
 *
 * Mesma régua do chat: tool do registry passa por requiredPermissions/adminOnly
 * e precisa valer no contexto OFFICE; legada passa por LEGACY_TOOL_ROUTES.
 * Serve para recusar na criação (Eme, API e editor) e para o disparo - um
 * alerta compartilhado nasce como cópia do destinatário, e ele pode não ter a
 * tela que o dado exige.
 */
async function checkToolForUser(name, user) {
    const r = resolveTool(name);
    if (!r) {
        return { ok: false, kind: null, reason: `A ferramenta "${name}" não existe na Eme. Use uma tool de dados registrada (ex.: query_leads, query_boletos, get_consolidated_sales).` };
    }
    if (r.kind === 'registry') {
        if (!r.tool.contexts.includes('OFFICE')) {
            return { ok: false, kind: r.kind, reason: `A ferramenta "${name}" não está disponível no Office.` };
        }
        const ok = await userHasPermissions(user, r.tool.requiredPermissions, r.tool.adminOnly);
        if (!ok) {
            const tela = (r.tool.requiredPermissions || []).join(', ') || (r.tool.adminOnly ? 'somente admin' : '');
            return { ok: false, kind: r.kind, reason: `O dono do alerta não tem acesso à tela que esta consulta usa (${tela}).` };
        }
        return { ok: true, kind: r.kind };
    }
    const ok = await legacyToolAllowed(user, name);
    return ok
        ? { ok: true, kind: r.kind }
        : { ok: false, kind: r.kind, reason: `O dono do alerta não tem alçada para consultar "${name}".` };
}

async function execute(rule, user) {
    const toolCall = rule.tool_call || {};
    const name = toolCall.tool;
    const check = await checkToolForUser(name, user);
    if (!check.ok) {
        return {
            preview: check.kind ? 'Sem acesso à consulta' : 'Tool não encontrada',
            report:  `❌ ${check.reason} Edite o alerta.`,
            raw:     { error: check.reason },
        };
    }

    const resolvedArgs = resolveArgs(toolCall.args || {}, rule.timezone || DEFAULT_TZ);

    try {
        // Registry: SecureRunner devolve o `result` da tool (mesmo objeto que o
        // chat renderiza) e grava o audit com sessionId nulo - o disparo do
        // alerta fica rastreável como qualquer consulta.
        const raw = check.kind === 'registry'
            ? await runSecureTool({ user, toolName: name, args: resolvedArgs, context: 'OFFICE' })
            : await executeTool(name, resolvedArgs, user);
        const resolvedToolCall = { tool: name, args: resolvedArgs };
        const route = toolToRoute(resolvedToolCall);
        const link  = linkAbsoluto(route);
        return {
            preview: renderPreview(raw, { fallback: rule.name }),
            report:  renderWhatsAppText(raw, { ruleName: rule.name, link }),
            blocks:  blocksDe(raw),
            route,
            link,
            raw,
            // tool_call com placeholders já resolvidos — usado pra montar links
            resolvedToolCall,
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
    resolveTool,
    checkToolForUser,
};
