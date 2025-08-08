// services/siengeService.js
import apiSienge from '../../../lib/apiSienge.js';
import db from '../../../models/sequelize/index.js';

const {
    SalesContract,
    SalesContractCustomer,
    SalesContractUnit,
    PaymentCondition,
    ContractLink
} = db;

export default class SiengeService {
    constructor() {
        this.limit = 200;
    }

    /** 1️⃣ Busca “página” de contratos */
    async fetchPage({ offset = 0, limit = this.limit, filters = {} } = {}) {
        console.log(`🕒 [API] Solicitando contratos offset=${offset} limit=${limit}`, filters);
        const { data } = await apiSienge.get('/v1/sales-contracts', {
            params: { offset, limit, ...filters }
        });
        console.log(`✅ [API] Recebidos ${data.results.length} / ${data.resultSetMetadata.count}`);
        return data;
    }

    /** 2️⃣ Carga inicial completa */
    async loadAll() {
        console.log('🚀 Iniciando carga FULL de todos os contratos');
        const startTs = Date.now();

        // primeira página para descobrir o total
        const firstPage = await this.fetchPage({ offset: 0 });
        const total = firstPage.resultSetMetadata.count;

        // processa em lotes
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
    }

    /** 3️⃣ Carga somente DELTA */
    // async loadDelta(lastRunAt) {
    //     console.log('🚀 Iniciando carga DELTA de contratos desde', lastRunAt);
    //     const filters = {
    //         createdAfter: lastRunAt.toISOString().slice(0, 10),
    //         modifiedAfter: lastRunAt.toISOString().slice(0, 10),
    //         initialIssueDate: lastRunAt.toISOString().slice(0, 10),
    //         initialCancelDate: lastRunAt.toISOString().slice(0, 10),
    //     };

    //     const first = await this.fetchPage({ offset: 0, filters });
    //     const total = first.resultSetMetadata.count;
    //     await this.upsertBatch(first.results);
    //     console.log(`   • Delta  ${first.results.length}/${total}`);

    //     let offset = this.limit;
    //     while (offset < total) {
    //         const { results } = await this.fetchPage({ offset, filters });
    //         await this.upsertBatch(results);
    //         console.log(`   • Delta  ${Math.min(offset + results.length, total)}/${total}`);
    //         offset += this.limit;
    //     }

    //     console.log(`🎉 Carga DELTA concluída: ${total} contratos processados`);
    // }

    /** 3️⃣ Carga somente DELTA, mas separada por tipo de mudança */
    async loadDelta(lastRunAt) {
        console.log('🚀 Iniciando carga DELTA de contratos desde', lastRunAt.toISOString());

        // helper que busca **todas** as páginas para um dado filtro
        const fetchAll = async filters => {
            let all = [], offset = 0;
            while (true) {
                const { resultSetMetadata, results } = await this.fetchPage({ offset, filters });
                all.push(...results);
                offset += this.limit;
                if (offset >= resultSetMetadata.count) break;
            }
            return all;
        };

        // 1️⃣ Novos contratos
        const created = await fetchAll({ createdAfter: lastRunAt.toISOString().slice(0, 10) });
        console.log(`   • Novos:         ${created.length}`);

        // 2️⃣ Contratos modificados (qualquer campo)
        const modified = await fetchAll({ modifiedAfter: lastRunAt.toISOString().slice(0, 10) });
        console.log(`   • Modificados:   ${modified.length}`);

        // 3️⃣ Contratos cuja data de emissão mudou (emitidos)
        const issued = await fetchAll({ initialIssueDate: lastRunAt.toISOString().slice(0, 10) });
        console.log(`   • Emitidos:      ${issued.length}`);

        // 4️⃣ Contratos distratados
        const cancelled = await fetchAll({ initialCancelDate: lastRunAt.toISOString().slice(0, 10) });
        console.log(`   • Distratados:    ${cancelled.length}`);

        // 5️⃣ Unifica todos por ID (evita duplicatas)
        const map = new Map();
        [...created, ...modified, ...issued, ...cancelled].forEach(raw => {
            map.set(raw.id, raw);
        });
        const batch = Array.from(map.values());
        console.log(`🎉 Total único a processar: ${batch.length}`);

        // 6️⃣ Grava tudo de uma vez
        await this.upsertBatch(batch);

        console.log('🎉 Carga DELTA concluída');
    }

    /** 4️⃣ Processa um lote de contratos */
    async upsertBatch(batch) {
        const CHUNK = 20;
        for (let i = 0; i < batch.length; i += CHUNK) {
            const slice = batch.slice(i, i + CHUNK);
            // para cada raw, fazemos o upsert completo
            await Promise.all(slice.map(raw => this.upsertOne(raw)));
        }
    }

    /** 🎯 Grava/atualiza Contrato + filhas */
    async upsertOne(raw) {
        // 1️⃣ Contrato principal
        const [contract] = await SalesContract.upsert(this.normalize(raw), { returning: true });
        const cid = contract.id;

        // --- Filhas: Customers ---
        await SalesContractCustomer.destroy({ where: { contract_id: cid } });
        if (raw.salesContractCustomers) {
            await SalesContractCustomer.bulkCreate(
                raw.salesContractCustomers.map(c => ({
                    contract_id: cid,
                    customer_id: c.id,
                    name: c.name,
                    main: c.main,
                    spouse: c.spouse,
                    participation_percentage: c.participationPercentage
                }))
            );
        }

        // --- Filhas: Units ---
        await SalesContractUnit.destroy({ where: { contract_id: cid } });
        if (raw.salesContractUnits) {
            await SalesContractUnit.bulkCreate(
                raw.salesContractUnits.map(u => ({
                    contract_id: cid,
                    unit_id: u.id,
                    name: u.name,
                    main: u.main,
                    participation_percentage: u.participationPercentage
                }))
            );
        }

        // --- Filhas: PaymentConditions ---
        await PaymentCondition.destroy({ where: { contract_id: cid } });
        if (raw.paymentConditions) {
            await PaymentCondition.bulkCreate(
                raw.paymentConditions.map(p => ({
                    contract_id: cid,
                    bearer_id: p.bearerId,
                    bearer_name: p.bearerName,
                    indexer_id: p.indexerId,
                    indexer_name: p.indexerName,
                    condition_type_id: p.conditionTypeId,
                    condition_type_name: p.conditionTypeName,
                    interest_type: p.interestType,
                    match_maturities: p.matchMaturities === 'S',
                    installments_number: p.installmentsNumber,
                    open_installments_number: p.openInstallmentsNumber,
                    months_grace_period: p.monthsGracePeriod,
                    first_payment_date: p.firstPayment,
                    base_date: p.baseDate,
                    base_date_interest: p.baseDateInterest,
                    total_value: p.totalValue,
                    outstanding_balance: p.outstandingBalance,
                    interest_percentage: p.interestPercentage,
                    total_value_interest: p.totalValueInterest,
                    amount_paid: p.amountPaid,
                    sequence_id: p.sequenceId,
                    order_number: p.orderNumber,
                    order_number_remade: p.orderNumberRemadeInstallments,
                    status: p.status,
                    paid_before_contract_additive: p.paidBeforeContractAdditive
                }))
            );
        }

        // --- Filhas: Links ---
        await ContractLink.destroy({ where: { contract_id: cid } });
        if (raw.links) {
            await ContractLink.bulkCreate(
                raw.links.map(l => ({
                    contract_id: cid,
                    rel: l.rel,
                    href: l.href
                }))
            );
        }
    }

    /** 📦 Normaliza o JSON da API para o nosso modelo principal */
    normalize(raw) {
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
            cancellation_date: raw.cancellationDate,
            value: raw.value,
            total_selling_value: raw.totalSellingValue,
            contract_date: raw.contractDate,
            issue_date: raw.issueDate,
            expected_delivery_date: raw.expectedDeliveryDate,
            accounting_date: raw.accountingDate,
            creation_date: raw.creationDate,
            last_update_date: raw.lastUpdateDate,
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
            financial_institution_date: raw.financialInstitutionDate,
            financial_institution_number: raw.financialInstitutionNumber
        };
    }
}
