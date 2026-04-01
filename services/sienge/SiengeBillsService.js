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

    /**
     * Busca o título pelo ID.
     * @returns {object|null}
     */
    static async getBill(billId) {
        if (!billId) return null;
        try {
            const { data } = await apiSienge.get(`/v1/bills/${Number(billId)}`);
            return data ?? null;
        } catch (err) {
            if (err.response?.status === 404) return null;
            throw err;
        }
    }

    /**
     * Busca as parcelas de um título.
     * @returns {Array}
     */
    static async getInstallments(billId) {
        if (!billId) return [];
        try {
            const { data } = await apiSienge.get(`/v1/bills/${Number(billId)}/installments`, {
                params: { limit: 200, offset: 0 },
            });
            return data?.results || [];
        } catch (err) {
            if (err.response?.status === 404) return [];
            throw err;
        }
    }

    /**
     * Anexa um arquivo ao título.
     * POST /v1/bills/{billId}/attachments
     * @param {number} billId
     * @param {string} description  - descrição do anexo (máx 500 chars)
     * @param {Buffer} fileBuffer   - conteúdo do arquivo
     * @param {string} filename     - nome do arquivo (máx 100 chars)
     * @param {string} [mimeType]   - ex: 'application/pdf'
     */
    static async attachBillFile(billId, description, fileBuffer, filename, mimeType = 'application/pdf') {
        const url = `/v1/bills/${Number(billId)}/attachments`;
        const form = new FormData();
        const blob = new Blob([fileBuffer], { type: mimeType });
        form.append('file', blob, String(filename || 'boleto.pdf').slice(0, 100));
        try {
            await apiSienge.post(url, form, {
                params: { description: String(description || 'Boleto').slice(0, 500) },
                headers: { 'Content-Type': 'multipart/form-data' },
                timeout: 60000,
            });
        } catch (err) {
            const detail = err.response?.data;
            const status = err.response?.status;
            console.error(`[SiengeBillsService] attachBillFile ${status} | url=${url} | response=${JSON.stringify(detail)}`);
            throw new Error(
                `Sienge ${status}: ${detail?.clientMessage || detail?.developerMessage || err.message}`
            );
        }
    }

    /**
     * Registra informação de pagamento (boleto bancário) em uma parcela.
     * paymentTypeId 2 = Boleto Bancário
     * @param {number} billId
     * @param {number} installmentId
     * @param {string} barcodeNumber  - código de barras do boleto
     */
    static async registerBoletoPayment(billId, installmentId, barcodeNumber) {
        const url = `/v1/bills/${Number(billId)}/installments/${Number(installmentId)}/payment-information/boleto-bancario`;

        // Sienge aceita no máximo 47 caracteres — remove espaços e limita
        const sanitized = String(barcodeNumber || '').replace(/\s/g, '').slice(0, 47);

        const body = {
            paymentTypeId: 2,
            boletoBancarioManualBarCodeNumber: sanitized,
        };
        try {
            await apiSienge.patch(url, body);
        } catch (err) {
            const detail = err.response?.data;
            const status = err.response?.status;
            console.error(`[SiengeBillsService] registerBoletoPayment ${status} | url=${url} | body=${JSON.stringify(body)} | response=${JSON.stringify(detail)}`);
            throw new Error(
                `Sienge ${status}: ${detail?.clientMessage || detail?.developerMessage || detail?.userMessage?.[0] || err.message}`
            );
        }
    }
}