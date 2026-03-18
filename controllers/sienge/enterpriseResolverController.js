// controllers/sienge/enterpriseResolverController.js
import { EnterpriseResolverService } from '../../services/sienge/EnterpriseResolverService.js';

/**
 * GET /api/sienge/payment-flow/enterprises
 * Lista empreendimentos com AMBOS companyId E erpId preenchidos.
 * Admin: vê todos. Não-admin: restrito à cidade do usuário (token city).
 * Aceita ?q=termo para autocomplete.
 */
export async function listFlowEnterprises(req, res, next) {
    try {
        const { q } = req.query;
        const isAdmin = req.user?.role === 'admin';
        const userCity = isAdmin ? null : (req.user?.city || null);

        if (!isAdmin && !userCity) {
            return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
        }

        let results = q
            ? await EnterpriseResolverService.search(q, { cityFilter: userCity })
            : await EnterpriseResolverService.listAll({ cityFilter: userCity });

        // Apenas empreendimentos com AMBOS companyId E erpId preenchidos
        results = results.filter(r => r.companyId && r.erpId);

        return res.json({ count: results.length, results });
    } catch (err) {
        next(err);
    }
}

/**
 * GET /api/sienge/payment-flow/enterprises/resolve?name=MARILIA/SP%20ED.%20VIEW%20360
 * Tenta resolver um nome (extraído da NF/boleto) para enterpriseId + companyId.
 * Admin: vê todos os candidatos. Não-admin: candidatos filtrados pela cidade do usuário.
 */
export async function resolveEnterprise(req, res, next) {
    try {
        const { name } = req.query;
        if (!name?.trim()) {
            return res.status(422).json({ error: 'Parâmetro "name" é obrigatório.' });
        }

        const isAdmin = req.user?.role === 'admin';
        const userCity = isAdmin ? null : (req.user?.city || null);

        const result = await EnterpriseResolverService.resolveByName(name, { cityFilter: userCity });

        return res.json(result);
    } catch (err) {
        next(err);
    }
}
