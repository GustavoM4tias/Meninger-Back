// controllers/enterpriseValueRuleController.js
//
// CRUD das regras de composição de VGV por empreendimento (Faturamento).
// Leitura liberada a qualquer autenticado (a regra vale para todos os usuários);
// escrita restrita a admin, igual às demais configurações do dashboard.

import db from '../models/sequelize/index.js';

const { EnterpriseValueRule } = db;

const VALID_MODES = new Set(['FULL', 'LAND_VALUE_ONLY', 'TR_ONLY']);

const serialize = (r) => ({
    id: r.id,
    enterprise_id: r.enterprise_id,
    enterprise_name: r.enterprise_name,
    gross_mode: r.gross_mode,
    net_mode: r.net_mode,
    description: r.description,
});

export async function listEnterpriseValueRules(req, res) {
    try {
        const rows = await EnterpriseValueRule.findAll({
            where: { active: true },
            order: [['enterprise_id', 'ASC']],
        });
        return res.json({ count: rows.length, results: rows.map(serialize) });
    } catch (err) {
        console.error('[listEnterpriseValueRules]', err);
        return res.status(500).json({ error: 'Erro ao listar regras de valor.' });
    }
}

export async function addEnterpriseValueRule(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const { enterprise_id, enterprise_name, gross_mode, net_mode, description } = req.body;
        const eid = Number(enterprise_id);
        const gross = String(gross_mode || 'FULL').toUpperCase();
        const net = String(net_mode || 'FULL').toUpperCase();

        if (!Number.isInteger(eid) || eid <= 0) return res.status(400).json({ error: 'enterprise_id inválido.' });
        if (!VALID_MODES.has(gross)) return res.status(400).json({ error: `gross_mode inválido. Use: ${[...VALID_MODES].join(', ')}.` });
        if (!VALID_MODES.has(net)) return res.status(400).json({ error: `net_mode inválido. Use: ${[...VALID_MODES].join(', ')}.` });
        if (gross === 'FULL' && net === 'FULL') {
            return res.status(400).json({ error: 'Regra sem efeito: ao menos um dos modos deve ser diferente de FULL.' });
        }

        const [row, created] = await EnterpriseValueRule.findOrCreate({
            where: { enterprise_id: eid },
            defaults: {
                enterprise_id: eid,
                enterprise_name: enterprise_name || null,
                gross_mode: gross,
                net_mode: net,
                description: description || null,
                active: true,
            },
        });

        if (!created) {
            row.active = true;
            row.gross_mode = gross;
            row.net_mode = net;
            if (enterprise_name) row.enterprise_name = enterprise_name;
            if (description !== undefined) row.description = description || null;
            await row.save();
        }

        return res.status(200).json(serialize(row));
    } catch (err) {
        console.error('[addEnterpriseValueRule]', err);
        return res.status(500).json({ error: 'Erro ao salvar regra de valor.' });
    }
}

export async function removeEnterpriseValueRule(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await EnterpriseValueRule.findByPk(idInt);
        if (!row) return res.status(404).json({ error: 'Regra não encontrada.' });

        row.active = false;
        await row.save();

        return res.json({ success: true });
    } catch (err) {
        console.error('[removeEnterpriseValueRule]', err);
        return res.status(500).json({ error: 'Erro ao remover regra de valor.' });
    }
}
