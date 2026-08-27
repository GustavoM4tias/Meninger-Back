// services/marketing/costCenterOptions.js
//
// Centros de custo do Sienge (cdempreendview) para alimentar selects.
// Leitura AO VIVO do backup, com cache curto em memória e o mesmo override
// administrativo de nome usado nas telas de Custos.
//
// Morava em marketingApprovalService.js; virou módulo próprio em 2026-08-19,
// quando o módulo de Aprovações foi removido e o Stand de Vendas ficou como
// único consumidor.

import db from '../../models/sequelize/index.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';
import { getScope, isErpAllowed } from '../permissions/accessScopeService.js';

const CC_CACHE_TTL_MS = Number(process.env.COST_CENTER_OPTIONS_TTL_MS || 10 * 60 * 1000);
let _ccCache = { at: 0, items: null };

export async function listCostCenters() {
    if (_ccCache.items && Date.now() - _ccCache.at < CC_CACHE_TTL_MS) {
        return { items: _ccCache.items };
    }
    try {
        const res = await siengeQuery(`
            SELECT cdempreendview AS code, nmempreend AS name
            FROM ecadempreend
            WHERE cdempreendview IS NOT NULL
            ORDER BY nmempreend NULLS LAST
        `);
        // Override administrativo de nome (mesma precedência das telas de Custos).
        const overrides = await db.CostCenterOverride.findAll({
            attributes: ['cost_center_id', 'display_name'], raw: true,
        }).catch(() => []);
        const nameByCc = new Map(overrides.map((o) => [Number(o.cost_center_id), o.display_name]));
        const items = res.rows.map((r) => ({
            code: Number(r.code),
            name: nameByCc.get(Number(r.code)) || r.name || `CC ${r.code}`,
        }));
        _ccCache = { at: Date.now(), items };
        return { items };
    } catch (err) {
        // Sienge fora do ar não pode travar o form — o vínculo é opcional.
        console.warn('[costCenterOptions.listCostCenters]', err?.message || err);
        return { items: _ccCache.items || [], unavailable: true };
    }
}

/**
 * A mesma lista, mas CORTADA pelo escopo do usuário: só os centros de custo dos
 * empreendimentos liberados para ele (mesma heurística de sub-CC do Custos).
 * É esta que alimenta select de tela — a de cima serve para traduzir código em
 * nome no que ele JÁ tem direito de ver, e por isso não filtra.
 */
export async function listCostCentersForUser(user) {
    const { items, unavailable } = await listCostCenters();
    const scope = await getScope(user);
    if (scope.all) return { items, unavailable };
    return {
        items: (items || []).filter((c) => isErpAllowed(scope, c.code)),
        unavailable,
    };
}

export default { listCostCenters, listCostCentersForUser };
