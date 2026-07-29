// controllers/sienge/enterpriseResolverController.js
import { EnterpriseResolverService } from '../../services/sienge/EnterpriseResolverService.js';
import { getScope, isErpAllowed } from '../../services/permissions/accessScopeService.js';

/**
 * GET /api/sienge/payment-flow/enterprises
 * Lista empreendimentos com AMBOS companyId E erpId preenchidos.
 * Admin: vê todos. Não-admin: restrito ao escopo de acesso do usuário
 * (accessScopeService; fail-closed: escopo vazio → lista vazia).
 * Aceita ?q=termo para autocomplete.
 */
export async function listFlowEnterprises(req, res, next) {
    try {
        const { q } = req.query;
        const scope = await getScope(req.user);

        let results = q
            ? await EnterpriseResolverService.search(q)
            : await EnterpriseResolverService.listAll();

        // Apenas empreendimentos com AMBOS companyId E erpId preenchidos
        results = results.filter(r => r.companyId && r.erpId);

        // Não-admin: restringe ao escopo (isErpAllowed cobre sub-CC)
        if (!scope.all) {
            results = results.filter(r => isErpAllowed(scope, r.erpId));
        }

        return res.json({ count: results.length, results });
    } catch (err) {
        next(err);
    }
}

/**
 * GET /api/sienge/payment-flow/enterprises/resolve?name=MARILIA/SP%20ED.%20VIEW%20360
 * Tenta resolver um nome (extraído da NF/boleto) para enterpriseId + companyId.
 * Admin: vê todos os candidatos. Não-admin: candidatos filtrados pelo escopo do usuário.
 */
export async function resolveEnterprise(req, res, next) {
    try {
        const { name } = req.query;
        if (!name?.trim()) {
            return res.status(422).json({ error: 'Parâmetro "name" é obrigatório.' });
        }

        const scope = await getScope(req.user);

        const result = await EnterpriseResolverService.resolveByName(name);

        // Não-admin: filtra candidatos fora do escopo (fail-closed)
        if (!scope.all) {
            const candidates = (result.candidates || []).filter(c => isErpAllowed(scope, c.erpId));
            return res.json({ best: candidates[0] || null, candidates });
        }

        return res.json(result);
    } catch (err) {
        next(err);
    }
}
