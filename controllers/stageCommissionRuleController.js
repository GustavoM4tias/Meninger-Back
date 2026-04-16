// controllers/stageCommissionRuleController.js
import db from '../models/sequelize/index.js';

const { StageCommissionRule } = db;

export async function listStageCommissionRules(req, res) {
    try {
        const rows = await StageCommissionRule.findAll({
            where: { active: true },
            order: [['enterprise_id', 'ASC'], ['stage_id', 'ASC']]
        });
        return res.json({
            count: rows.length,
            results: rows.map(r => ({
                id: r.id,
                enterprise_id: r.enterprise_id,
                enterprise_name: r.enterprise_name,
                stage_id: r.stage_id,
                stage_name: r.stage_name,
                commission_pct: Number(r.commission_pct),
                description: r.description
            }))
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao listar regras de comissão.' });
    }
}

export async function addStageCommissionRule(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const { enterprise_id, enterprise_name, stage_id, stage_name, commission_pct, description } = req.body;
        const eid = Number(enterprise_id);
        const sid = Number(stage_id);
        const pct = Number(commission_pct);

        if (!Number.isInteger(eid) || eid <= 0) return res.status(400).json({ error: 'enterprise_id inválido.' });
        if (!Number.isInteger(sid) || sid <= 0) return res.status(400).json({ error: 'stage_id inválido.' });
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 1) return res.status(400).json({ error: 'commission_pct inválido (deve ser entre 0 e 1, ex: 0.04).' });

        const [row, created] = await StageCommissionRule.findOrCreate({
            where: { enterprise_id: eid, stage_id: sid },
            defaults: {
                enterprise_id: eid,
                enterprise_name: enterprise_name || null,
                stage_id: sid,
                stage_name: stage_name || null,
                commission_pct: pct,
                description: description || null,
                active: true
            }
        });

        if (!created) {
            row.active = true;
            row.commission_pct = pct;
            if (enterprise_name) row.enterprise_name = enterprise_name;
            if (stage_name) row.stage_name = stage_name;
            if (description !== undefined) row.description = description || null;
            await row.save();
        }

        return res.status(200).json({
            id: row.id,
            enterprise_id: row.enterprise_id,
            enterprise_name: row.enterprise_name,
            stage_id: row.stage_id,
            stage_name: row.stage_name,
            commission_pct: Number(row.commission_pct),
            description: row.description
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao adicionar regra de comissão.' });
    }
}

export async function removeStageCommissionRule(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await StageCommissionRule.findByPk(idInt);
        if (!row) return res.status(404).json({ error: 'Regra não encontrada.' });

        row.active = false;
        await row.save();

        return res.json({ success: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao remover regra de comissão.' });
    }
}
