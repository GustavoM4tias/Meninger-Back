// src/controllers/cv/workflow.js
import {
    getRepasseWorkflows,
    getReservaWorkflows
} from '../../services/workflowService.js';

export const fetchWorkflowsRepasse = async (req, res) => {
    try {
        const withCounts = String(req.query?.withCounts || 'true').toLowerCase() !== 'false';
        const data = await getRepasseWorkflows({ withCounts });
        res.status(200).json({ tipo: 'repasse', count: data.length, results: data });
    } catch (err) {
        console.error('Erro em fetchWorkflowsRepasse:', err);
        res.status(500).json({ error: 'Erro ao buscar workflows de repasse' });
    }
};

export const fetchWorkflowsReserva = async (req, res) => {
    try {
        const withCounts = String(req.query?.withCounts || 'true').toLowerCase() !== 'false';
        const data = await getReservaWorkflows({ withCounts });
        res.status(200).json({ tipo: 'reserva', count: data.length, results: data });
    } catch (err) {
        console.error('Erro em fetchWorkflowsReserva:', err);
        res.status(500).json({ error: 'Erro ao buscar workflows de reserva' });
    }
};

export const fetchWorkflows = async (req, res) => {
    try {
        const withCounts = String(req.query?.withCounts || 'true').toLowerCase() !== 'false';
        const [repasse, reserva] = await Promise.all([
            getRepasseWorkflows({ withCounts }),
            getReservaWorkflows({ withCounts }),
        ]);
        res.status(200).json({
            repasse: { count: repasse.length, results: repasse },
            reserva: { count: reserva.length, results: reserva }
        });
    } catch (err) {
        console.error('Erro em fetchWorkflows:', err);
        res.status(500).json({ error: 'Erro ao buscar workflows' });
    }
};
