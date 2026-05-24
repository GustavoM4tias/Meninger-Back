// services/OfficeAI/ToolRegistry.js
//
// Registro central de tools do Eme.
//
// Cada tool é declarada com:
//   name              — string única (= function name no Gemini)
//   description       — string usada na declaration do Gemini
//   parameters        — Zod-like schema simples para validar args
//   requiredPermissions — array de permission names (vazia = qualquer user autenticado)
//   adminOnly         — boolean (atalho para "só admin")
//   contexts          — array ['ACADEMY','OFFICE'] (ambos por default; algumas só Office)
//   handler           — async fn (user, args, runtime) → { result, resultIds?, resultCount? }
//
// A regra principal: **filtros de segurança (city/role/audience) são
// aplicados DENTRO do handler com base em `user`, NUNCA em `args`**.
// Args do Gemini só são "hints" da intenção do usuário — fonte da verdade
// para permissão é sempre o req.user no servidor.

import db from '../../models/sequelize/index.js';

// Catálogo carregado lazy (evita require cycle).
const registry = new Map();

export function registerTool(tool) {
    if (!tool || !tool.name || typeof tool.handler !== 'function') {
        throw new Error('Tool inválida — falta name/handler.');
    }
    registry.set(tool.name, {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
        requiredPermissions: Array.isArray(tool.requiredPermissions) ? tool.requiredPermissions : [],
        adminOnly: !!tool.adminOnly,
        contexts: Array.isArray(tool.contexts) ? tool.contexts.map(s => String(s).toUpperCase()) : ['ACADEMY', 'OFFICE'],
        handler: tool.handler,
    });
}

export function getRegisteredTools() {
    return Array.from(registry.values());
}

export function findTool(name) {
    return registry.get(String(name || '')) || null;
}

/**
 * Verifica se um user tem as permissões necessárias para uma tool.
 * Hoje usa: user.role==='admin' como bypass, e tabela user_permissions.
 * Para versão mais granular, integrar com permissionMiddleware/permissionStore.
 */
async function userHasPermissions(user, requiredPermissions = [], adminOnly = false) {
    if (!user) return false;
    const isAdmin = user.role === 'admin';

    if (adminOnly && !isAdmin) return false;
    if (!requiredPermissions.length) return true;
    if (isAdmin) return true; // admin bypass

    // Lazy load das permissions do user
    try {
        const perms = await db.UserPermission.findAll({
            where: { user_id: user.id },
            attributes: ['router'],
            raw: true,
        });
        const permSet = new Set(perms.map(p => String(p.router || '').toLowerCase()));
        return requiredPermissions.every(p => permSet.has(String(p).toLowerCase()));
    } catch (err) {
        console.warn('[ToolRegistry] permission check failed', err?.message);
        return false;
    }
}

/**
 * Filtra tools que estão disponíveis para um user em um contexto.
 * Bate em:
 *   - contexts inclui o context atual
 *   - user tem requiredPermissions (ou é admin)
 *
 * @param {object} user     - req.user
 * @param {string} context  - 'ACADEMY' | 'OFFICE'
 * @returns {Promise<Array>} tools elegíveis
 */
export async function getToolsFor(user, context = 'OFFICE') {
    const ctx = String(context || 'OFFICE').toUpperCase();
    const out = [];
    for (const tool of registry.values()) {
        if (!tool.contexts.includes(ctx)) continue;
        const ok = await userHasPermissions(user, tool.requiredPermissions, tool.adminOnly);
        if (!ok) continue;
        out.push(tool);
    }
    return out;
}

/**
 * Helper: devolve as declarations no formato Gemini para um conjunto de tools.
 */
export function toGeminiDeclarations(tools = []) {
    return tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));
}

export { userHasPermissions };
