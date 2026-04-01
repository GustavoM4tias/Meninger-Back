// services/sienge/siengeDataService.js
import apiSienge from '../../../lib/apiSienge.js';
import db from '../../../models/sequelize/index.js';

const { SalesContract } = db;

export default class SiengeService {
    constructor() { this.limit = 200; }

    async fetchPage({ offset = 0, limit = this.limit, filters = {} } = {}) {
        console.log(`🕒 [API] Solicitando contratos offset=${offset} limit=${limit}`, filters);
        const { data } = await apiSienge.get('/v1/sales-contracts', {
            params: { offset, limit, ...filters }
        });
        console.log(`✅ [API] Recebidos ${data.results.length} / ${data.resultSetMetadata.count}`);
        return data;
    }

    async loadAll() {
        console.log('🚀 Iniciando carga FULL de todos os contratos');
        const startTs = Date.now();

        const firstPage = await this.fetchPage({ offset: 0 });
        const total = firstPage.resultSetMetadata.count;

        await this.upsertBatch(firstPage.results);
        console.log(`   • Gravados  ${firstPage.results.length}/${total}`);

        let offset = this.limit;
        while (offset < total) {
            const { results } = await this.fetchPage({ offset });
            await this.upsertBatch(results);
            console.log(`   • Gravados  ${Math.min(offset + results.length, total)}/${total}`);
            offset += this.limit;
        }

        console.log(`🎉 Carga FULL concluída: ${total} contratos em ${((Date.now() - startTs) / 1000).toFixed(1)}s`);
        await this.deduplicateContracts();
    }

    async loadDelta(lastRunAt) {
        const d = lastRunAt.toISOString().slice(0, 10);
        const fetchAll = async filters => {
            let all = [], offset = 0;
            while (true) {
                const { results, resultSetMetadata } = await this.fetchPage({ offset, filters });
                all.push(...results);
                offset += this.limit;
                if (offset >= resultSetMetadata.count) break;
            }
            return all;
        };

        const created = await fetchAll({ createdAfter: d });
        const modified = await fetchAll({ modifiedAfter: d });
        const issued = await fetchAll({ initialIssueDate: d });
        const cancelled = await fetchAll({ initialCancelDate: d });

        const uniq = new Map();
        [...created, ...modified, ...issued, ...cancelled].forEach(r => uniq.set(r.id, r));
        await this.upsertBatch([...uniq.values()]);
        await this.deduplicateContracts();
    }

    /**
     * Remove contratos órfãos duplicados do banco local.
     *
     * Contexto: o Sienge pode criar um novo ID de contrato para o mesmo número de contrato
     * dentro da mesma empresa quando um empreendimento é migrado/copiado entre módulos
     * (ex: MOD. III → MOD. IV). O contrato antigo permanece "Emitido" no Sienge e o sync
     * espelha ambos fielmente — gerando duplicatas locais.
     *
     * Regra: dentro da mesma empresa (company_id), o número de contrato (number) deve ser
     * único entre os registros não-cancelados. Quando há mais de um, mantemos o mais
     * recentemente atualizado (updated_at DESC) e deletamos os demais.
     */
    async deduplicateContracts() {
        try {
            const [deleted] = await db.sequelize.query(`
                WITH ranked AS (
                    SELECT id,
                           number,
                           company_id,
                           enterprise_id,
                           ROW_NUMBER() OVER (
                               PARTITION BY company_id, number
                               ORDER BY updated_at DESC, id DESC
                           ) AS rn
                    FROM contracts
                    WHERE situation != 'Cancelado'
                )
                DELETE FROM contracts
                WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
                RETURNING id, number, company_id, enterprise_id
            `);

            if (deleted.length > 0) {
                console.log(
                    `🧹 [Sync] Deduplicação removeu ${deleted.length} contrato(s) órfão(s): ` +
                    deleted.map(d => `id=${d.id} n°${d.number} emp=${d.enterprise_id}`).join(' | ')
                );
            }
            return deleted.length;
        } catch (err) {
            console.warn(`⚠️  [Sync] deduplicateContracts falhou (não crítico): ${err.message}`);
            return 0;
        }
    }

    async upsertBatch(batch) {
        const CHUNK = 50;
        for (let i = 0; i < batch.length; i += CHUNK) {
            await Promise.all(batch.slice(i, i + CHUNK).map(raw => this.upsertOne(raw)));
        }
    }

    async upsertOne(raw) {
        const normalized = this.normalize(raw);
        await SalesContract.upsert({
            ...normalized,
            // ⛔ sem raw
            customers: raw.salesContractCustomers || [],
            units: raw.salesContractUnits || [],
            payment_conditions: raw.paymentConditions || [],
            links_json: raw.links || [],
        });
    }

    normalize(raw) {
        const d = v => (v ? String(v).slice(0, 10) : null); // garante YYYY-MM-DD
        return {
            id: raw.id,
            company_id: raw.companyId,
            internal_company_id: raw.internalCompanyId,
            company_name: raw.companyName,
            enterprise_id: raw.enterpriseId,
            enterprise_name: raw.enterpriseName,
            number: raw.number,
            external_id: raw.externalId,
            correction_type: raw.correctionType,
            situation: raw.situation,
            discount_type: raw.discountType,
            discount_percentage: raw.discountPercentage,
            cancellation_reason: raw.cancellationReason,
            cancellation_date: d(raw.cancellationDate),
            value: raw.value,
            total_selling_value: raw.totalSellingValue,
            contract_date: d(raw.contractDate),
            issue_date: d(raw.issueDate),
            expected_delivery_date: d(raw.expectedDeliveryDate),
            accounting_date: d(raw.accountingDate),
            creation_date: d(raw.creationDate),
            last_update_date: d(raw.lastUpdateDate),
            contains_remade_installments: raw.containsRemadeInstallments,
            special_clause: raw.specialClause,
            pro_rata_indexer: raw.proRataIndexer,
            interest_percentage: raw.interestPercentage,
            interest_type: raw.interestType,
            fine_rate: raw.fineRate,
            late_interest_calc_type: raw.lateInterestCalculationType,
            daily_late_interest_value: raw.dailyLateInterestValue,
            total_cancellation_amount: raw.totalCancellationAmount,
            receivable_bill_id: raw.receivableBillId,
            cancellation_payable_bill_id: raw.cancellationPayableBillId,
            financial_institution_date: d(raw.financialInstitutionDate),
            financial_institution_number: raw.financialInstitutionNumber
        };
    }
}


