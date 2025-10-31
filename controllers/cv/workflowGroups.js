import {
    syncWorkflowGroups,
    upsertWorkflowGroup,
    deleteWorkflowGroup
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
        const { tipo, nome, descricao, situacoes_ids } = req.body;
        if (!tipo || !nome || !Array.isArray(situacoes_ids))
            return res.status(400).json({ error: 'Campos obrigatórios: tipo, nome, situacoes_ids' });

        const grupo = await upsertWorkflowGroup({ tipo, nome, descricao, situacoes_ids });
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
