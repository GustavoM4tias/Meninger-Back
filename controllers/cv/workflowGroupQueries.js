// controllers/cv/workflowGroupQueries.js
import { getGroupProjections } from '../../services/cv/workflowGroupQueriesService.js';
 
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

    const data = await getGroupProjections({
      idgroup,
      isAdmin,
      userCity: userCityRaw
    });

    return res.json(data);
  } catch (err) {
    console.error('Erro ao buscar projeções do grupo:', err);
    return res.status(500).json({ error: 'Erro ao buscar projeções do grupo.' });
  }
}
