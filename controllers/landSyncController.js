// src/controllers/sienge/landSyncController.js
import db from '../models/sequelize/index.js';

const { LandSyncEnterprise } = db;

export async function listLandSyncEnterprises(req, res) {
    try {
        const isAdmin = req.user?.role === 'admin';
        if (!isAdmin) {
            return res.status(403).json({ error: 'Acesso negado.' });
        }

        const rows = await LandSyncEnterprise.findAll({
            where: { active: true },
            order: [['enterprise_id', 'ASC']]
        });

        const results = rows.map(r => ({
            id: r.id,
            enterprise_id: r.enterprise_id,
            enterprise_name: r.enterprise_name
        }));

        return res.json({ count: results.length, results });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao listar empreendimentos de terreno externo.' });
    }
}

export async function addLandSyncEnterprise(req, res) {
    try {
        const isAdmin = req.user?.role === 'admin';
        if (!isAdmin) {
            return res.status(403).json({ error: 'Acesso negado.' });
        }

        const { enterprise_id, enterprise_name } = req.body;
        const idInt = Number(enterprise_id);
        if (!Number.isInteger(idInt)) {
            return res.status(400).json({ error: 'enterprise_id inválido.' });
        }

        // upsert simples
        const [row] = await LandSyncEnterprise.findOrCreate({
            where: { enterprise_id: idInt },
            defaults: {
                enterprise_id: idInt,
                enterprise_name: enterprise_name || null,
                active: true
            }
        });

        if (!row.active || row.enterprise_name !== enterprise_name) {
            row.active = true;
            if (enterprise_name) row.enterprise_name = enterprise_name;
            await row.save();
        }

        return res.status(200).json({
            id: row.id,
            enterprise_id: row.enterprise_id,
            enterprise_name: row.enterprise_name
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao adicionar empreendimento de terreno externo.' });
    }
}

export async function removeLandSyncEnterprise(req, res) {
    try {
        const isAdmin = req.user?.role === 'admin';
        if (!isAdmin) {
            return res.status(403).json({ error: 'Acesso negado.' });
        }

        const { id } = req.params;
        const idInt = Number(id);
        if (!Number.isInteger(idInt)) {
            return res.status(400).json({ error: 'ID inválido.' });
        }

        const row = await LandSyncEnterprise.findByPk(idInt);
        if (!row) {
            return res.status(404).json({ error: 'Registro não encontrado.' });
        }

        // soft delete (desativar)
        row.active = false;
        await row.save();

        return res.json({ success: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao remover empreendimento de terreno externo.' });
    }
}
