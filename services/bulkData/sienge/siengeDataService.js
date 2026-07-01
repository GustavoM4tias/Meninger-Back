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
     * Roda duas passadas complementares:
     *
     * 1) Mesmo NÚMERO de contrato dentro da mesma empresa.
     *    Contexto: o Sienge pode criar um novo ID de contrato para o mesmo número de contrato
     *    dentro da mesma empresa quando um empreendimento é migrado/copiado entre módulos
     *    (ex: MOD. III → MOD. IV). O contrato antigo permanece "Emitido" no Sienge e o sync
     *    espelha ambos fielmente — gerando duplicatas locais.
     *
     * 2) Mesma UNIDADE + CLIENTE dentro do mesmo empreendimento (números diferentes).
     *    Contexto: quando um contrato é EXCLUÍDO no Sienge (não cancelado) e reemitido com
     *    um NÚMERO novo, a API de contratos simplesmente para de retornar o antigo. O delta
     *    sync só faz upsert do que a API devolve e nunca aprende que o antigo sumiu, então o
     *    registro obsoleto fica preso como "Emitido" para sempre. No Faturamento os dois
     *    contratos caem na mesma venda (mesmo cliente+unidade+empreendimento) e os valores
     *    são somados → total duplicado. A passada 1 não pega isso porque os números diferem.
     *
     * Regra (ambas): entre os registros NÃO-cancelados de uma mesma chave, mantemos o mais
     * recentemente atualizado (updated_at DESC) e deletamos os demais. Um contrato realmente
     * excluído no Sienge deixa de receber updates e envelhece; o vigente segue sendo
     * sincronizado, então é o que sobrevive.
     */
    async deduplicateContracts() {
        let removed = 0;
        try {
            // ── Passada 1: mesmo (company_id, number) ────────────────────────────
            const [byNumber] = await db.sequelize.query(`
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

            if (byNumber.length > 0) {
                removed += byNumber.length;
                console.log(
                    `🧹 [Sync] Dedup por número removeu ${byNumber.length} contrato(s) órfão(s): ` +
                    byNumber.map(d => `id=${d.id} n°${d.number} emp=${d.enterprise_id}`).join(' | ')
                );
            }
        } catch (err) {
            console.warn(`⚠️  [Sync] deduplicateContracts (passada 1) falhou (não crítico): ${err.message}`);
        }

        try {
            // ── Passada 2: mesmo (company_id, enterprise_id, unidade, cliente) ────
            // Só considera registros com unidade E cliente identificáveis, para não
            // colapsar contratos com dados incompletos por engano.
            const [byUnit] = await db.sequelize.query(`
                WITH keyed AS (
                    SELECT
                        id,
                        number,
                        company_id,
                        enterprise_id,
                        updated_at,
                        COALESCE(
                            (SELECT NULLIF(u ->> 'id','')::bigint
                             FROM jsonb_array_elements(units) u
                             WHERE (u ->> 'main')::boolean = true LIMIT 1),
                            (SELECT NULLIF(u ->> 'id','')::bigint
                             FROM jsonb_array_elements(units) u LIMIT 1)
                        ) AS unit_id,
                        COALESCE(
                            (SELECT NULLIF(c ->> 'id','')::bigint
                             FROM jsonb_array_elements(customers) c
                             WHERE (c ->> 'main')::boolean = true LIMIT 1),
                            (SELECT NULLIF(c ->> 'id','')::bigint
                             FROM jsonb_array_elements(customers) c
                             ORDER BY (c ->> 'id')::int NULLS LAST LIMIT 1)
                        ) AS customer_id
                    FROM contracts
                    WHERE situation != 'Cancelado'
                ),
                ranked AS (
                    SELECT id, number, company_id, enterprise_id, unit_id, customer_id,
                           ROW_NUMBER() OVER (
                               PARTITION BY company_id, enterprise_id, unit_id, customer_id
                               ORDER BY updated_at DESC, id DESC
                           ) AS rn
                    FROM keyed
                    WHERE unit_id IS NOT NULL
                      AND customer_id IS NOT NULL
                )
                DELETE FROM contracts
                WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
                RETURNING id, number, company_id, enterprise_id
            `);

            if (byUnit.length > 0) {
                removed += byUnit.length;
                console.log(
                    `🧹 [Sync] Dedup por unidade+cliente removeu ${byUnit.length} contrato(s) obsoleto(s) ` +
                    `(reemitidos no Sienge com número novo): ` +
                    byUnit.map(d => `id=${d.id} n°${d.number} emp=${d.enterprise_id}`).join(' | ')
                );
            }
        } catch (err) {
            console.warn(`⚠️  [Sync] deduplicateContracts (passada 2) falhou (não crítico): ${err.message}`);
        }

        return removed;
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


