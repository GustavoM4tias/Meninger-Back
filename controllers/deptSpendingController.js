// src/controllers/deptSpendingController.js
//
// Tela "Gastos por Departamento" (reestruturação da Viabilidade de Marketing).
// Governança: a diretoria (não-admin) só recebe empreendimentos LIBERADOS; o
// admin recebe tudo (rascunho + liberado) para ajustar no backoffice.

import DeptSpendingService from '../services/deptSpending/deptSpendingService.js';

const service = new DeptSpendingService();

function normYM(v) {
    const ym = String(v || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`month inválido: ${v}`);
    return ym;
}

export async function getEnterpriseSpending(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const { erpId } = req.params;
        const { year, aliasId = 'default', month } = req.query;

        const start_month = req.query.start_month ? normYM(req.query.start_month) : null;
        const end_month = req.query.end_month ? normYM(req.query.end_month) : null;

        const parsedYear = year ? Number(year) : null;
        if (!start_month && !end_month) {
            if (!parsedYear || parsedYear < 2000) return res.status(400).json({ error: 'Parâmetro year inválido.' });
        } else {
            if (!start_month || !end_month) return res.status(400).json({ error: 'Envie start_month e end_month juntos.' });
        }

        const data = await service.computeEnterpriseViability({
            year: parsedYear,
            upToMonth: month ? normYM(month) : null,
            startMonth: start_month,
            endMonth: end_month,
            aliasId,
            erpId,
        });

        return res.json(data);
    } catch (e) {
        console.error('[DeptSpendingController] getEnterpriseSpending: erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao calcular gastos por departamento.' });
    }
}

export const getEnterprisesSpending = async (req, res) => {
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

        // Governança: só admin enxerga rascunhos. Diretoria (não-admin) recebe só os liberados.
        const isAdmin = req.user?.role === 'admin';

        const out = await service.listEnterprisesViability({
            year: parsedYear,
            upToMonth: month ? normYM(month) : null,
            startMonth: start_month,
            endMonth: end_month,
            aliasId: aliasId || 'default',
            onlyReleased: !isAdmin,
        });

        return res.json({ ...out, isAdmin });
    } catch (e) {
        console.error('[DeptSpendingController] getEnterprisesSpending erro', e);
        return res.status(500).json({ error: e.message || 'Erro ao carregar gastos por departamento' });
    }
};
