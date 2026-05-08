// controllers/cv/workflowGroupQueries.js
import { getGroupProjections } from '../../services/cv/workflowGroupQueriesService.js';

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

    const isAdmin = req.user?.role === 'admin';
    const userCityRaw = isAdmin ? null : (req.user?.city || '').trim();

    if (!isAdmin && !userCityRaw) {
      return res.status(403).json({ error: 'Cidade do usuário não configurada.' });
    }

    const companyIds = parseIdCsv(req.query.companyIds ?? req.query.companyId);
    const enterpriseIds = parseIdCsv(req.query.enterpriseIds ?? req.query.enterpriseId);

    const data = await getGroupProjections({
      idgroup,
      isAdmin,
      userCity: userCityRaw,
      companyIds,
      enterpriseIds
    });

    return res.json(data);
  } catch (err) {
    console.error('Erro ao buscar projeções do grupo:', err);
    return res.status(500).json({ error: 'Erro ao buscar projeções do grupo.' });
  }
}
