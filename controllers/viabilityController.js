// src/controllers/viabilityController.js
import ViabilityService from '../services/viabilityService.js';

const service = new ViabilityService();

function normYM(v) {
    const ym = String(v || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`month inválido: ${v}`);
    return ym;
}

export async function getEnterpriseViability(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const { erpId } = req.params;

        // compat (antigo)
        const { year, aliasId = 'default', cvEnterpriseId, costCenterId, month } = req.query;

        // novo
        const start_month = req.query.start_month ? normYM(req.query.start_month) : null;
        const end_month = req.query.end_month ? normYM(req.query.end_month) : null;

        const parsedYear = year ? Number(year) : null;
        if (!start_month && !end_month) {
            if (!parsedYear || parsedYear < 2000) return res.status(400).json({ error: 'Parâmetro year inválido.' });
        } else {
            if (!start_month || !end_month) return res.status(400).json({ error: 'Envie start_month e end_month juntos.' });
        }

        // No novo padrão o identificador real é enterprise_key.
        // Para não quebrar rota, vamos assumir:
        // - enterpriseKey = erpId (se você ainda chama por ERP)
        // Depois você pode trocar rota para /enterprise/:enterpriseKey
        const enterpriseKey = String(erpId);

        const data = await service.computeEnterpriseViability({
            year: parsedYear,
            upToMonth: month ? normYM(month) : null,

            startMonth: start_month,
            endMonth: end_month,

            enterpriseKey,
            aliasId,
            erpId, // mantém vendas com ERP se existir
            cvEnterpriseId: cvEnterpriseId ? Number(cvEnterpriseId) : undefined,
            costCenterId: costCenterId ? Number(costCenterId) : (erpId ? Number(erpId) : null)
        });

        return res.json(data);
    } catch (e) {
        console.error('[ViabilityController] getEnterpriseViability: erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao calcular viabilidade.' });
    }
}

export const getEnterprisesViability = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const { year, aliasId, month } = req.query;

        const start_month = req.query.start_month ? normYM(req.query.start_month) : null;
        const end_month = req.query.end_month ? normYM(req.query.end_month) : null;

        const parsedYear = year ? Number(year) : null;
        if (!start_month && !end_month) {
            if (!parsedYear || parsedYear < 2000) return res.status(400).json({ error: 'Parâmetro year inválido.' });
        } else {
            if (!start_month || !end_month) return res.status(400).json({ error: 'Envie start_month e end_month juntos.' });
        }

        const out = await service.listEnterprisesViability({
            year: parsedYear,
            upToMonth: month ? normYM(month) : null,

            startMonth: start_month,
            endMonth: end_month,

            aliasId: aliasId || 'default'
        });

        return res.json(out);
    } catch (e) {
        console.error('[ViabilityController] getEnterprisesViability erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar viabilidade de empreendimentos' });
    }
};
