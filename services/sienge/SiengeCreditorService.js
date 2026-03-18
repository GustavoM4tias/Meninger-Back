// services/sienge/SiengeCreditorService.js
import apiSienge from '../../lib/apiSienge.js';

export class SiengeCreditorService {
    /**
     * Busca credor no Sienge por CNPJ ou CPF (só números).
     * Retorna o primeiro resultado ou null se não encontrar.
     * @param {string} cnpjOrCpf - Somente dígitos, sem máscara
     * @returns {{ id, name, tradeName, cnpj, cpf, active } | null}
     */
    static async findByDocument(cnpjOrCpf) {
        if (!cnpjOrCpf) return null;

        const digits = String(cnpjOrCpf).replace(/\D/g, '');
        if (!digits) return null;

        const isCnpj = digits.length === 14;
        const isCpf = digits.length === 11;

        if (!isCnpj && !isCpf) {
            console.warn(`[SiengeCreditorService] Documento inválido: ${digits}`);
            return null;
        }

        const params = isCnpj ? { cnpj: digits } : { cpf: digits };

        try {
            const { data } = await apiSienge.get('/v1/creditors', { params: { ...params, limit: 5 } });
            const results = data?.results || [];
            if (!results.length) return null;

            const creditor = results[0];
            return {
                id: creditor.id,
                name: creditor.name,
                tradeName: creditor.tradeName || null,
                cnpj: creditor.cnpj || null,
                cpf: creditor.cpf || null,
                active: creditor.active,
                paymentTypeId: creditor.paymentTypeId || null,
                raw: creditor,
            };
        } catch (err) {
            if (err.response?.status === 404) return null;
            console.error('[SiengeCreditorService] Erro ao buscar credor:', err.response?.status, err.message);
            throw err;
        }
    }
}