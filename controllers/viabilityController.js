// src/controllers/viabilityController.js
import ViabilityService from '../services/viabilityService.js';

const service = new ViabilityService();

/**
 * GET /api/viability/enterprise/:erpId
 *   ?year=2025
 *   [&aliasId=default]
 *   [&cvEnterpriseId=123]   // idempreendimento do CV
 *   [&costCenterId=80001]   // centro de custo no módulo de despesas
 *   [&month=2025-03]        // limite até o mês (acumulado até esse mês)
 */
export async function getEnterpriseViability(req, res) {
    try {
        if (!req.user) {
            console.warn('[ViabilityController] getEnterpriseViability: usuário não autenticado');
            return res.status(401).json({ error: 'Usuário não autenticado.' });
        }

        const { erpId } = req.params;
        const { year, aliasId = 'default', cvEnterpriseId, costCenterId, month } = req.query;

        console.log('[ViabilityController] getEnterpriseViability: IN', {
            userId: req.user?.id,
            erpId,
            year,
            aliasId,
            cvEnterpriseId,
            costCenterId,
            month
        });

        const parsedYear = Number(year);
        if (!parsedYear || parsedYear < 2000) {
            console.warn('[ViabilityController] getEnterpriseViability: year inválido', { year });
            return res.status(400).json({ error: 'Parâmetro year inválido.' });
        }

        const data = await service.computeEnterpriseViability({
            year: parsedYear,
            erpId,
            aliasId,
            cvEnterpriseId: cvEnterpriseId ? Number(cvEnterpriseId) : undefined,
            costCenterId: costCenterId ? Number(costCenterId) : Number(erpId),
            upToMonth: month || null
        });

        console.log('[ViabilityController] getEnterpriseViability: OUT ok', {
            erpId,
            year: parsedYear,
            month: month || null
        });

        return res.json(data);
    } catch (e) {
        console.error('[ViabilityController] getEnterpriseViability: erro', {
            error: e.message,
            stack: e.stack
        });
        return res.status(500).json({ error: e.message || 'Erro ao calcular viabilidade.' });
    }
}

/**
 * GET /api/viability/enterprises
 *   ?year=2025
 *   [&aliasId=default]
 *   [&month=2025-03]   // acumulado até esse mês
 *
 * Retorna a lista de empreendimentos que têm projeção ativa no ano/alias,
 * com o HEADER de viabilidade calculado para cada um.
 */
export const getEnterprisesViability = async (req, res) => {
    try {
        const userId = req.user.id;
        const { year, aliasId, month } = req.query;

        const svc = new ViabilityService();

        const out = await svc.listEnterprisesViability({
            year: Number(year),
            aliasId: aliasId || 'default',
            upToMonth: month || null,
            userId
        });

        res.json(out);
    } catch (e) {
        console.error('[ViabilityController] getEnterprisesViability erro', e);
        res.status(500).json({ error: 'Erro ao carregar viabilidade de empreendimentos' });
    }
};