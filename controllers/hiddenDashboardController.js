// controllers/hiddenDashboardController.js
import db from '../models/sequelize/index.js';

const { HiddenDashboardEnterprise } = db;

export async function listHiddenEnterprises(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const rows = await HiddenDashboardEnterprise.findAll({
            where: { active: true },
            order: [['enterprise_id', 'ASC']]
        });

        return res.json({
            count: rows.length,
            results: rows.map(r => ({ id: r.id, enterprise_id: r.enterprise_id, enterprise_name: r.enterprise_name }))
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao listar empreendimentos ocultos.' });
    }
}

export async function addHiddenEnterprise(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const { enterprise_id, enterprise_name } = req.body;
        const idInt = Number(enterprise_id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'enterprise_id inválido.' });

        const [row] = await HiddenDashboardEnterprise.findOrCreate({
            where: { enterprise_id: idInt },
            defaults: { enterprise_id: idInt, enterprise_name: enterprise_name || null, active: true }
        });

        if (!row.active || row.enterprise_name !== enterprise_name) {
            row.active = true;
            if (enterprise_name) row.enterprise_name = enterprise_name;
            await row.save();
        }

        return res.status(200).json({ id: row.id, enterprise_id: row.enterprise_id, enterprise_name: row.enterprise_name });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao ocultar empreendimento.' });
    }
}

export async function removeHiddenEnterprise(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await HiddenDashboardEnterprise.findByPk(idInt);
        if (!row) return res.status(404).json({ error: 'Registro não encontrado.' });

        row.active = false;
        await row.save();

        return res.json({ success: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao remover ocultação.' });
    }
}
