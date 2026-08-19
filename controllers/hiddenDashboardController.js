// controllers/hiddenDashboardController.js
import db from '../models/sequelize/index.js';
import contractsCache from '../services/sienge/contractsQueryCache.js';

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

// Aceita um único { enterprise_id, enterprise_name } (formato legado) ou um
// lote { items: [{ enterprise_id, enterprise_name }, ...] }. O ocultar por
// empresa no front expande em dezenas de centros de custo e uma request por
// CC deixava a operação lenta — em lote é uma request só.
export async function addHiddenEnterprise(req, res) {
    try {
        // Ocultar/restaurar muda quem entra no dashboard.
        contractsCache.invalidate('empreendimento oculto');
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const isBulk = Array.isArray(req.body?.items);
        const raw = isBulk ? req.body.items : [req.body || {}];

        const seen = new Set();
        const items = [];
        for (const it of raw) {
            const idInt = Number(it?.enterprise_id);
            if (!Number.isInteger(idInt) || seen.has(idInt)) continue;
            seen.add(idInt);
            items.push({ enterprise_id: idInt, enterprise_name: it?.enterprise_name || null });
        }
        if (!items.length) return res.status(400).json({ error: 'enterprise_id inválido.' });

        const results = [];
        for (const it of items) {
            const [row] = await HiddenDashboardEnterprise.findOrCreate({
                where: { enterprise_id: it.enterprise_id },
                defaults: { ...it, active: true }
            });

            if (!row.active || (it.enterprise_name && row.enterprise_name !== it.enterprise_name)) {
                row.active = true;
                if (it.enterprise_name) row.enterprise_name = it.enterprise_name;
                await row.save();
            }
            results.push({ id: row.id, enterprise_id: row.enterprise_id, enterprise_name: row.enterprise_name });
        }

        if (!isBulk) return res.status(200).json(results[0]);
        return res.status(200).json({ count: results.length, results });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao ocultar empreendimento.' });
    }
}

// Restaura vários de uma vez (ex.: "Restaurar todos" de uma empresa).
export async function restoreHiddenEnterprises(req, res) {
    try {
        // Ocultar/restaurar muda quem entra no dashboard.
        contractsCache.invalidate('empreendimento oculto');
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
            .map(Number)
            .filter(Number.isInteger);
        if (!ids.length) return res.status(400).json({ error: 'ids inválidos.' });

        await HiddenDashboardEnterprise.update({ active: false }, { where: { id: ids } });
        return res.json({ success: true, count: ids.length });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erro ao restaurar empreendimentos.' });
    }
}

export async function removeHiddenEnterprise(req, res) {
    try {
        // Ocultar/restaurar muda quem entra no dashboard.
        contractsCache.invalidate('empreendimento oculto');
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
