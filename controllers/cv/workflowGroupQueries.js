// controllers/cv/workflowGroupQueries.js
import { getGroupProjections } from '../../services/cv/workflowGroupQueriesService.js';
import { visibleErpIds } from '../../services/permissions/accessScopeService.js';

function parseIdCsv(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => Number(String(v).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (typeof value === 'string' && value.trim().length) {
    return value
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  return [];
}

export async function fetchGroupProjections(req, res) {
  try {
    const idgroup = parseInt(req.params.id, 10);
    if (!Number.isInteger(idgroup)) {
      return res.status(400).json({ error: 'id inválido' });
    }

    // Escopo de acesso (accessScopeService): null = admin (sem filtro);
    // fail-closed: escopo vazio → resposta vazia.
    const scopeErpIds = await visibleErpIds(req.user);
    if (scopeErpIds !== null && !scopeErpIds.length) {
      return res.json({ count: 0, results: [], meta: { scoped: true } });
    }

    const companyIds = parseIdCsv(req.query.companyIds ?? req.query.companyId);
    const enterpriseIds = parseIdCsv(req.query.enterpriseIds ?? req.query.enterpriseId);

    const data = await getGroupProjections({
      idgroup,
      scopeErpIds,
      companyIds,
      enterpriseIds
    });

    return res.json(data);
  } catch (err) {
    console.error('Erro ao buscar projeções do grupo:', err);
    return res.status(500).json({ error: 'Erro ao buscar projeções do grupo.' });
  }
}
