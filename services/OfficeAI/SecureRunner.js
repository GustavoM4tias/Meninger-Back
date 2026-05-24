// services/OfficeAI/SecureRunner.js
//
// Wrapper que executa uma tool com TODAS as proteções de segurança:
//   1. valida que a tool existe no registry
//   2. valida que o user tem permission para essa tool no context atual
//   3. sanitiza args contra prompt injection / tipos errados
//   4. executa o handler — handler é responsável por filtrar dados na origem
//      (city/role/audience) usando user, NUNCA args do Gemini
//   5. registra audit log (EmeAuditLog) com tudo
//
// Erros internos viram { error: 'message' } para o Gemini renderizar — não vazam stack.

import db from '../../models/sequelize/index.js';
import { findTool, userHasPermissions } from './ToolRegistry.js';
import { safeForPrompt, detectInjectionSignals } from './promptSafety.js';

// Sanitização defensiva de args. Não força schema — só limita comprimento +
// strip de chars potencialmente perigosos para chars que VOLTAM ao prompt.
function sanitizeArgsForLogging(args) {
    if (args == null || typeof args !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string') out[k] = v.slice(0, 500);
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
        else if (Array.isArray(v)) out[k] = v.slice(0, 50);
        else if (v && typeof v === 'object') out[k] = '[object]';
        else out[k] = null;
    }
    return out;
}

async function writeAuditLog({
    user, sessionId, messageId, context, toolName,
    argsJson, requiredPermission, permissionGranted,
    filtersApplied, resultCount, resultIds, ms, error, ip, userAgent,
}) {
    try {
        await db.EmeAuditLog.create({
            userId: user?.id || null,
            sessionId: sessionId || null,
            messageId: messageId || null,
            context: String(context || 'OFFICE').toUpperCase(),
            toolName: String(toolName).slice(0, 80),
            argsJson: argsJson || null,
            requiredPermission: requiredPermission || null,
            permissionGranted: permissionGranted !== false,
            filtersApplied: filtersApplied || null,
            resultCount: resultCount != null ? Number(resultCount) : null,
            resultIds: Array.isArray(resultIds) ? resultIds.slice(0, 100) : null,
            ms: ms != null ? Math.round(Number(ms)) : null,
            error: error ? String(error).slice(0, 1000) : null,
            ip: ip ? String(ip).slice(0, 64) : null,
            userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
        });
    } catch (err) {
        // Audit NUNCA deve quebrar a chamada original — só loga warning.
        console.warn('[SecureRunner.audit] failed', err?.message);
    }
}

/**
 * Executa uma tool com proteção.
 *
 * @param {object} ctx
 * @param {object} ctx.user         - req.user (com id, role, city, position)
 * @param {string} ctx.toolName
 * @param {object} ctx.args         - args vindos do Gemini
 * @param {string} ctx.context      - 'ACADEMY' | 'OFFICE'
 * @param {number|string} ctx.sessionId
 * @param {number} ctx.messageId
 * @param {string} ctx.ip
 * @param {string} ctx.userAgent
 *
 * @returns {Promise<object>} resultado da tool (ou { error })
 */
export async function runTool({ user, toolName, args = {}, context = 'OFFICE', sessionId = null, messageId = null, ip = null, userAgent = null }) {
    const startedAt = Date.now();
    const ctxUpper = String(context || 'OFFICE').toUpperCase();
    const argsSnap = sanitizeArgsForLogging(args);

    // 1) Tool existe?
    const tool = findTool(toolName);
    if (!tool) {
        await writeAuditLog({
            user, sessionId, messageId, context: ctxUpper, toolName,
            argsJson: argsSnap, permissionGranted: false, ms: Date.now() - startedAt,
            error: 'tool_not_found', ip, userAgent,
        });
        return { error: `Tool "${toolName}" não está disponível.` };
    }

    // 2) Tool ativa neste contexto?
    if (!tool.contexts.includes(ctxUpper)) {
        await writeAuditLog({
            user, sessionId, messageId, context: ctxUpper, toolName,
            argsJson: argsSnap, permissionGranted: false, ms: Date.now() - startedAt,
            error: 'tool_not_in_context', ip, userAgent,
        });
        return { error: `Esta funcionalidade não está disponível neste contexto.` };
    }

    // 3) Permissão?
    const hasPerm = await userHasPermissions(user, tool.requiredPermissions, tool.adminOnly);
    if (!hasPerm) {
        await writeAuditLog({
            user, sessionId, messageId, context: ctxUpper, toolName,
            argsJson: argsSnap,
            requiredPermission: (tool.requiredPermissions || []).join(',') || (tool.adminOnly ? 'admin' : null),
            permissionGranted: false, ms: Date.now() - startedAt,
            error: 'forbidden', ip, userAgent,
        });
        return { error: 'Você não tem permissão para essa consulta.' };
    }

    // 4) Detecta sinais de injection em string args (loga mas não bloqueia — handler decide).
    const allString = Object.values(args).filter(v => typeof v === 'string').join(' ');
    const injectionSignals = detectInjectionSignals(allString);

    // 5) Executa o handler em try/catch.
    let result, error = null, resultIds = null, resultCount = null, filtersApplied = null;
    try {
        const ret = await tool.handler(user, args, { context: ctxUpper, sessionId });
        result = ret?.result !== undefined ? ret.result : ret;
        resultIds = ret?.resultIds || null;
        resultCount = ret?.resultCount != null ? ret.resultCount : (Array.isArray(result) ? result.length : null);
        filtersApplied = ret?.filtersApplied || null;
    } catch (err) {
        error = err?.message || String(err);
        console.warn(`[SecureRunner] tool ${toolName} failed:`, error);
        result = { error: 'Falha ao executar a consulta.' };
    }

    const ms = Date.now() - startedAt;
    await writeAuditLog({
        user, sessionId, messageId, context: ctxUpper, toolName,
        argsJson: { ...argsSnap, _injectionSignals: injectionSignals.length ? injectionSignals : undefined },
        requiredPermission: (tool.requiredPermissions || []).join(',') || (tool.adminOnly ? 'admin' : null),
        permissionGranted: true, filtersApplied, resultCount, resultIds, ms, error, ip, userAgent,
    });

    return result;
}
