// services/sienge/SiengeBillsService.js
/**
 * Verifica se um lançamento já foi registrado/pago anteriormente no Sienge
 * consultando o endpoint GET /v1/bills.
 *
 * Usado pelo pipeline para evitar falso "saldo insuficiente" quando na
 * verdade o contrato foi usado em lançamento anterior já quitado.
 *
 * Lógica de matching:
 *  - CRAVADO  : documentNumber bate E valor está dentro de 1% de tolerância
 *  - SUSPEITO : valor bate (tolerância 1%) mas documento não bate
 *  - NADA     : nenhum título compatível encontrado
 */
import apiSienge from '../../lib/apiSienge.js';

const TOLERANCE = 0.01; // 1% de diferença de valor é aceita

function withinTolerance(a, b) {
    if (!a || !b) return false;
    const diff = Math.abs(Number(a) - Number(b));
    return diff / Math.max(Math.abs(Number(a)), Math.abs(Number(b))) <= TOLERANCE;
}

export class SiengeBillsService {
    /**
     * Busca títulos no Sienge e verifica se o lançamento já existe.
     *
     * @param {object} params
     * @param {number}  params.creditorId   - siengeCreditorId
     * @param {number}  params.debtorId     - companyId (empresa no Sienge)
     * @param {number}  params.costCenterId - erpId (centro de custo)
     * @param {string}  params.documentNumber - nfNumber extraído da NF
     * @param {number}  params.amount          - unitPrice do lançamento
     * @param {string}  [params.startDate]     - busca a partir de (padrão: 2 anos atrás)
     * @param {string}  [params.endDate]       - busca até (padrão: hoje)
     *
     * @returns {{ status: 'cravado'|'suspeito'|'nenhum', bill: object|null, bills: object[] }}
     */
    static async checkPreviousLaunch({ creditorId, debtorId, costCenterId, documentNumber, amount, startDate, endDate }) {
        const today = new Date().toISOString().slice(0, 10);
        const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const params = new URLSearchParams({
            startDate: startDate || twoYearsAgo,
            endDate: endDate || today,
            limit: '200',
            offset: '0',
        });
        if (creditorId) params.set('creditorId', String(creditorId));
        if (debtorId) params.set('debtorId', String(debtorId));
        if (costCenterId) params.set('costCenterId', String(costCenterId));

        let bills = [];
        try {
            const res = await apiSienge.get(`/v1/bills?${params.toString()}`);
            bills = res.data?.results || [];
        } catch (err) {
            // Falha na API não deve travar o pipeline — retorna inconclusivo
            console.warn('[SiengeBillsService] Erro ao consultar /v1/bills:', err.message);
            return { status: 'nenhum', bill: null, bills: [], error: err.message };
        }

        if (!bills.length) return { status: 'nenhum', bill: null, bills: [] };

        const docNorm = (documentNumber || '').toString().trim().toUpperCase();

        // 1. Procura correspondência de documento + valor
        if (docNorm) {
            const cravado = bills.find(b => {
                const billDoc = (b.documentNumber || '').toString().trim().toUpperCase();
                return billDoc === docNorm && withinTolerance(b.totalInvoiceAmount, amount);
            });
            if (cravado) return { status: 'cravado', bill: cravado, bills };
        }

        // 2. Procura correspondência somente de valor (documento diferente ou ausente)
        const suspeito = bills.find(b => withinTolerance(b.totalInvoiceAmount, amount));
        if (suspeito) return { status: 'suspeito', bill: suspeito, bills };

        return { status: 'nenhum', bill: null, bills };
    }
}