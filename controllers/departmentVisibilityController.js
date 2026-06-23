// controllers/departmentVisibilityController.js
//
// Endpoints ADMIN-ONLY para configurar a visibilidade de departamentos em cascata
// (global → cargo → usuário). Montados em permissionRoutes (/api/permissions/...).

import * as svc from '../services/permissions/departmentVisibilityService.js';

function actor(req) {
    return req.user?.username || req.user?.email || String(req.user?.id || '');
}

// GET /permissions/department-visibility/meta → { departments, positions }
export async function getMeta(req, res) {
    try {
        const [departments, orgDepartments, positions, users] = await Promise.all([
            svc.listDepartments(),
            svc.listOrgDepartments(),
            svc.listPositions(),
            svc.listUsers(),
        ]);
        return res.json({ departments, orgDepartments, positions, users });
    } catch (e) {
        console.error('[deptVisibility] getMeta', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar metadados.' });
    }
}

// GET /permissions/department-visibility?scope=global|position|user&key=...
export async function getRules(req, res) {
    try {
        const { scope = 'global', key = '' } = req.query;
        const rules = await svc.getRules(scope, key);
        return res.json({ scope, key, rules });
    } catch (e) {
        console.error('[deptVisibility] getRules', e);
        return res.status(400).json({ error: e.message || 'Erro ao carregar regras.' });
    }
}

// PUT /permissions/department-visibility  body { scope, key, departmentName, hidden }
export async function putRule(req, res) {
    try {
        const { scope, key, departmentName, hidden } = req.body || {};
        const out = await svc.setRule({ scope, key, departmentName, hidden }, actor(req));
        return res.json(out);
    } catch (e) {
        console.error('[deptVisibility] putRule', e);
        return res.status(400).json({ error: e.message || 'Erro ao salvar regra.' });
    }
}

// DELETE /permissions/department-visibility  body { scope, key, departmentName }
export async function deleteRule(req, res) {
    try {
        const { scope, key, departmentName } = req.body || {};
        await svc.clearRule({ scope, key, departmentName });
        return res.json({ ok: true });
    } catch (e) {
        console.error('[deptVisibility] deleteRule', e);
        return res.status(400).json({ error: e.message || 'Erro ao remover regra.' });
    }
}
