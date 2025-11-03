import {
    syncWorkflowGroups,
    upsertWorkflowGroup,
    deleteWorkflowGroup,
  getDistinctSegments, // <- service puro
} from '../../services/cv/workflowGroupService.js';

export const fetchWorkflowGroups = async (req, res) => {
    try {
        const tipo = req.query.tipo || 'reservas'; // reservas | repasses
        const grupos = await syncWorkflowGroups(tipo);
        res.json(grupos);
    } catch (err) {
        console.error('Erro ao buscar grupos:', err);
        res.status(500).json({ error: err.message });
    }
};

export const createOrUpdateWorkflowGroup = async (req, res) => {
    try {
        const { tipo, nome, descricao, situacoes_ids, segmentos } = req.body;
        if (!tipo || !nome || !Array.isArray(situacoes_ids)) {
            return res.status(400).json({ error: 'Campos obrigatórios: tipo, nome, situacoes_ids' });
        }
        // segmentos é opcional (array ou string). O service já normaliza.
        const grupo = await upsertWorkflowGroup({ tipo, nome, descricao, situacoes_ids, segmentos });

        res.json(grupo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

export const removeWorkflowGroup = async (req, res) => {
    try {
        const { id } = req.params;
        await deleteWorkflowGroup(id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
 
// NOVO: lista de segmentos (para o <select>)
export const fetchListSegments = async (_req, res) => {
  try {
    const results = await getDistinctSegments();
    res.json({ results });
  } catch (err) {
    console.error('Erro ao buscar listagem de segmentos:', err);
    res.status(500).json({ error: err.message });
  }
};