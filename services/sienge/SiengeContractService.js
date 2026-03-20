// services/sienge/SiengeContractService.js
import apiSienge from '../../lib/apiSienge.js';

// Datas dinâmicas: 20 anos antes e 20 anos à frente do ano atual
function searchDateRange() {
    const year = new Date().getFullYear();
    return {
        contractStartDate: `${year - 20}-01-01`,
        contractEndDate:   `${year + 20}-12-31`,
    };
}

const API_PAGE_LIMIT = 200; // limite máximo permitido pela API Sienge

/**
 * Mapeamento completo por tipo de lançamento.
 *
 * documento        → código do documento no Sienge (campo "Documento" na criação do contrato)
 * budgetIndex      → índice 1-based do item de orçamento na planilha
 * accountIndex     → índice 1-based da conta financeira no modal
 * budgetItem       → descrição do item do orçamento (para auditoria/display)
 * financialAccount → código + descrição da conta financeira (para auditoria/display)
 *
 * Fontes:
 *  Premiação → doc PREM  | orç [5]  80159 Comissões          | cta [158] 2.02.02.80 Premiações Relacionadas à Vendas
 *  ITBI      → doc ITBI  | orç [16] 80145 Taxas e Emolumentos | cta [105] 2.02.02.12 Certidões, Registros, Cartório
 *  Marketing → doc CT    | orç [9]  80146 Marketing, Brindes  | cta [154] 2.02.02.75 Brindes, Promoções, Ações de Mkt
 *  CEF       → doc PCEF  | orç [16] 80145 Taxas e Emolumentos | cta [424] 2.17.03 Despesas Caixa (Produto)
 *  Cartório  → doc CART  | orç [16] 80145 Taxas e Emolumentos | cta [105] 2.02.02.12 Certidões, Registros, Cartório
 *  Stand     → doc CT    | orç [10] 80139 Despesas c/ Stand   | cta [184] 2.02.07 Despesas com Stand
 */
export const LAUNCH_TYPE_CONFIG = {
    Premiação: {
        documento: 'PREM',
        budgetIndex: 5,
        accountIndex: 158,
        budgetItem: 'Comissões',
        financialAccount: '2.02.02.80 - Premiações Relacionadas à Vendas',
    },
    ITBI: {
        documento: 'ITBI',
        budgetIndex: 16,
        accountIndex: 105,
        budgetItem: 'Taxas e Emolumentos',
        financialAccount: '2.02.02.12 - Certidões, Registros, Cartório - Adm',
    },
    Marketing: {
        documento: 'CT',
        budgetIndex: 9,
        accountIndex: 154,
        budgetItem: 'Marketing, Brindes, Promoções e Eventos',
        financialAccount: '2.02.02.75 - Brindes, Promoções, Ações de Marketing e Eventos',
    },
    CEF: {
        documento: 'PCEF',
        budgetIndex: 16,
        accountIndex: 424,
        budgetItem: 'Taxas e Emolumentos',
        financialAccount: '2.17.03 - Despesas Caixa (Produto) - Pago pela Empresa',
    },
    Cartório: {
        documento: 'CART',
        budgetIndex: 16,
        accountIndex: 105,
        budgetItem: 'Taxas e Emolumentos',
        financialAccount: '2.02.02.12 - Certidões, Registros, Cartório - Adm',
    },
    Stand: {
        documento: 'CT',
        budgetIndex: 10,
        accountIndex: 184,
        budgetItem: 'Despesas com Estrutura Local e/ou Stand de Vendas',
        financialAccount: '2.02.07 - Despesas com Stand',
    },
};

/**
 * Overrides por companyId — use quando os índices diferem para uma empresa específica.
 * Exemplo:
 *   export const LAUNCH_TYPE_BUDGET_OVERRIDES = {
 *     57: { Premiação: { budgetIndex: 7, accountIndex: 160 } },
 *   };
 */
export const LAUNCH_TYPE_BUDGET_OVERRIDES = {};

// ── Helpers exportados (usados pelo PipelineService e controller) ─────────────

/** Código do documento Sienge para o tipo de lançamento */
export function getLaunchDocument(launchType) {
    return LAUNCH_TYPE_BUDGET_OVERRIDES[null]?.[launchType]?.documento
        ?? LAUNCH_TYPE_CONFIG[launchType]?.documento
        ?? 'PCEF';
}

/** Índice 1-based do item de orçamento (com override por empresa) */
export function getBudgetIndex(launchType, companyId) {
    return LAUNCH_TYPE_BUDGET_OVERRIDES[companyId]?.[launchType]?.budgetIndex
        ?? LAUNCH_TYPE_CONFIG[launchType]?.budgetIndex
        ?? null;
}

/** Índice 1-based da conta financeira (com override por empresa) */
export function getAccountIndex(launchType, companyId) {
    return LAUNCH_TYPE_BUDGET_OVERRIDES[companyId]?.[launchType]?.accountIndex
        ?? LAUNCH_TYPE_CONFIG[launchType]?.accountIndex
        ?? null;
}

/** Retorna a config completa para um tipo (útil para display) */
export function getLaunchConfig(launchType) {
    return LAUNCH_TYPE_CONFIG[launchType] || null;
}

// Exportações de compatibilidade (usadas pelo PipelineService legado)
export const LAUNCH_TYPE_DOCUMENT = Object.fromEntries(
    Object.entries(LAUNCH_TYPE_CONFIG).map(([k, v]) => [k, v.documento])
);
export const LAUNCH_TYPE_BUDGET_INDEX = Object.fromEntries(
    Object.entries(LAUNCH_TYPE_CONFIG).map(([k, v]) => [k, v.budgetIndex])
);
export const LAUNCH_TYPE_ACCOUNT_INDEX = Object.fromEntries(
    Object.entries(LAUNCH_TYPE_CONFIG).map(([k, v]) => [k, v.accountIndex])
);
export const DEFAULT_CONTRACT_TYPE = '1';
export const DEFAULT_BUILDING_UNIT = '1';

// ── Service ───────────────────────────────────────────────────────────────────
export class SiengeContractService {

    /**
     * Busca contrato de fornecimento por supplierId (resolvido a partir do CNPJ).
     *
     * Estratégia:
     *  - Usa companyId + buildingId para filtrar no servidor (mais preciso)
     *  - Pagina com offset até esgotar todos os resultados (limit 200 por página)
     *  - Datas dinâmicas: 20 anos antes e 20 anos depois do ano atual
     *  - Filtra client-side por supplierId
     *  - Se não achar com buildingId, retenta sem buildingId (mesmo companyId)
     *  - Prefere contratos APPROVED + autorizados
     *
     * @param {number|string} supplierId  - ID do credor no Sienge
     * @param {number|string} companyId   - Código da empresa no Sienge
     * @param {number|string} buildingId  - Código da obra (erpId)
     */
    static async findBySupplierId(supplierId, companyId = null, buildingId = null) {
        if (!supplierId) return null;

        const { contractStartDate, contractEndDate } = searchDateRange();
        const scoreContract = c =>
            (c.statusApproval === 'APPROVED' ? 2 : 0) + (c.isAuthorized ? 1 : 0);

        /**
         * Busca todas as páginas da API para um dado conjunto de parâmetros,
         * filtrando client-side por supplierId.
         */
        const fetchAllPages = async (extraParams) => {
            const baseParams = {
                contractStartDate,
                contractEndDate,
                limit: API_PAGE_LIMIT,
                ...extraParams,
            };

            const matching = [];
            let offset = 0;

            while (true) {
                const { data } = await apiSienge.get('/v1/supply-contracts/all', {
                    params: { ...baseParams, offset },
                });
                const results = data?.results || [];
                const total   = data?.resultSetMetadata?.count ?? results.length;

                for (const c of results) {
                    if (Number(c.supplierId) === Number(supplierId)) matching.push(c);
                }

                offset += results.length;
                if (offset >= total || results.length === 0) break;
            }

            return matching;
        };

        try {
            const serverParams = {};
            if (companyId)  serverParams.companyId  = Number(companyId);
            if (buildingId) serverParams.buildingId = Number(buildingId);

            // Tentativa 1: companyId + buildingId
            let found = await fetchAllPages(serverParams);

            // Tentativa 2: só companyId (sem buildingId) — cobre obra divergente
            if (!found.length && buildingId && companyId) {
                found = await fetchAllPages({ companyId: Number(companyId) });
            }

            // Tentativa 3: sem filtros de empresa/obra — busca global
            if (!found.length) {
                found = await fetchAllPages({});
            }

            if (!found.length) return null;

            return found.sort((a, b) => scoreContract(b) - scoreContract(a))[0];
        } catch (err) {
            if (err.response?.status === 404) return null;
            throw err;
        }
    }

    /** Busca contrato por documentId + contractNumber (para polling) */
    static async getByIds(documentId, contractNumber) {
        if (!documentId || !contractNumber) return null;
        try {
            const { data } = await apiSienge.get('/v1/supply-contracts', {
                params: { documentId, contractNumber },
            });
            return data;
        } catch (err) {
            if (err.response?.status === 404) return null;
            throw err;
        }
    }

    /**
     * Busca dados de uma medição pelo número (para polling de autorização).
     */
    static async getMeasurement(documentId, contractNumber, buildingId, measurementNumber) {
        if (!documentId || !contractNumber || !buildingId || !measurementNumber) return null;
        try {
            const { data } = await apiSienge.get('/v1/supply-contracts/measurements', {
                params: {
                    documentId,
                    contractNumber,
                    buildingId: Number(buildingId),
                    measurementNumber: Number(measurementNumber),
                },
            });
            return data;
        } catch (err) {
            if (err.response?.status === 404) return null;
            throw err;
        }
    }

    /**
     * Valida se o contrato tem saldo suficiente para o lançamento.
     * buildingId = enterprise_cities.erp_id (centro de custo, ex: 35067)
     */
    static async validateItems(documentId, contractNumber, buildingId, buildingUnitId = 1, requiredValue = 0) {
        if (!documentId || !contractNumber || !buildingId) {
            return { ok: false, items: [], balanceAvailable: 0, error: 'Parâmetros insuficientes' };
        }
        try {
            const { data } = await apiSienge.get('/v1/supply-contracts/items', {
                params: {
                    documentId,
                    contractNumber,
                    buildingId: Number(buildingId),
                    buildingUnitId: Number(buildingUnitId) || 1,
                    limit: 200,
                },
            });
            const items = data?.results || [];
            let maxBalance = 0;
            const enriched = items.map(item => {
                const labor = (Number(item.quantity) || 0) * (Number(item.laborPrice) || 0);
                const material = (Number(item.quantity) || 0) * (Number(item.materialPrice) || 0);
                const measured = (item.buildingAppropriations?.[0]?.measuredQuantity || 0)
                    * ((Number(item.laborPrice) || 0) + (Number(item.materialPrice) || 0));
                const balance = Math.max(0, labor + material - measured);
                if (balance > maxBalance) maxBalance = balance;
                return { ...item, _balanceEstimate: balance };
            });
            return {
                ok: maxBalance >= (Number(requiredValue) || 0),
                items: enriched,
                balanceAvailable: maxBalance,
            };
        } catch (err) {
            if (err.response?.status === 404) {
                return { ok: false, items: [], balanceAvailable: 0, error: 'Contrato/itens não encontrados' };
            }
            return { ok: false, items: [], balanceAvailable: 0, error: err.message };
        }
    }
}