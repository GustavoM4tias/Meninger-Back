// services/sienge/billsService.js
import apiSienge from '../../lib/apiSienge.js';
import db from '../../models/sequelize/index.js';

const { SiengeBill, Sequelize } = db;
const { Op } = Sequelize;

export default class BillsService {
    constructor() {
        this.limit = 200;
    }

    /** Normalização pro nosso modelo local */
    normalize(raw, context = {}) {
        const d = v => (v ? String(v).slice(0, 10) : null);

        return {
            id: raw.id,
            debtor_id: raw.debtorId,
            creditor_id: raw.creditorId,
            cost_center_id: context.costCenterId || null,

            document_identification_id: raw.documentIdentificationId,
            document_number: raw.documentNumber,
            issue_date: d(raw.issueDate),
            installments_number: raw.installmentsNumber,

            total_invoice_amount: raw.totalInvoiceAmount,
            discount: raw.discount,
            status: raw.status,
            origin_id: raw.originId,

            notes: raw.notes,

            registered_user_id: raw.registeredUserId,
            registered_by: raw.registeredBy,
            registered_date: raw.registeredDate,
            changed_user_id: raw.changedUserId,
            changed_by: raw.changedBy,
            changed_date: raw.changedDate,

            access_key_number: raw.accessKeyNumber,
            tenant_url: raw.tenantUrl,

            links_json: raw.links || [],
        };
    }

    /** Chama /v1/bills com paginação (busca INICIAL SEMPRE no Sienge) */
    async fetchPage({ offset = 0, limit = this.limit, filters = {} } = {}) {
        console.log(`🧾 [API] Buscando bills offset=${offset} limit=${limit}`, filters);

        try {
            const { data } = await apiSienge.get('/v1/bills', {
                params: { offset, limit, ...filters }
            });
            console.log(`✅ [API] Recebidos ${data.results.length} / ${data.resultSetMetadata.count}`);
            return data;
        } catch (err) {
            // 404 no /v1/bills -> trata como "sem resultado", não como erro
            if (err.response && err.response.status === 404) {
                console.warn('⚠️ [Sienge] 404 em /v1/bills, tratando como lista vazia.', {
                    params: { offset, limit, ...filters },
                    providerData: err.response.data
                });

                return {
                    resultSetMetadata: {
                        count: 0,
                        offset,
                        limit
                    },
                    results: []
                };
            }

            console.error('❌ [Sienge] Erro ao chamar /v1/bills', err.response?.status, err.response?.data);
            throw err;
        }
    }

    /** Busca TODAS as páginas do /v1/bills */
    async fetchAll(filters = {}) {
        const all = [];
        let offset = 0;

        while (true) {
            const { results, resultSetMetadata } = await this.fetchPage({ offset, filters });
            all.push(...results);
            offset += this.limit;
            if (offset >= resultSetMetadata.count) break;
        }

        return all;
    }

    /** Upsert de UM título (campos básicos) sem mexer em departments_json */
    async upsertBasic(raw, context = {}) {
        const normalized = this.normalize(raw, context);

        const existing = await SiengeBill.findByPk(raw.id);
        if (!existing) {
            return SiengeBill.create(normalized);
        }

        await existing.update(normalized);
        return existing;
    }

    /** Busca departments-cost NO Sienge por ID e salva no bill (somente se ainda não tiver) */
    async ensureDepartments(billOrId, linksFromApi) {
        const bill = typeof billOrId === 'number'
            ? await SiengeBill.findByPk(billOrId)
            : billOrId;

        if (!bill) return null;

        // Se já tem json de departamentos, não chama o Sienge de novo
        if (bill.departments_json && bill.departments_json.length) {
            return bill;
        }

        const links = linksFromApi || bill.links_json || [];
        const depLink = links.find(l => l.rel === 'departmentsCost');
        if (!depLink) {
            console.warn(`⚠️ Bill ${bill.id} sem link departments-cost`);
            return bill;
        }

        // console.log(`🏷️ [API] Buscando departments-cost do bill ${bill.id}`);

        // exemplo: /v1/bills/466257/departments-cost
        const relativePath = depLink.href.replace('https://api.sienge.com.br/menin/public/api', '');
        const { data } = await apiSienge.get(relativePath);

        const departments = (data.results || []).map(r => ({
            departmentId: r.departmentId,
            departmentName: r.departmentName,
            percentage: r.percentage,
        }));

        let main = null;
        if (departments.length) {
            main = departments.reduce((a, b) =>
                (a.percentage || 0) >= (b.percentage || 0) ? a : b
            );
        }

        await bill.update({
            departments_json: departments,
            main_department_id: main ? main.departmentId : null,
            main_department_name: main ? main.departmentName : null,
        });

        return bill;
    }

    /**
     * 🚀 Fluxo que você descreveu (Sienge + banco + paralelo):
     *
     * 1) Busca SEMPRE no Sienge (/v1/bills) com costCenterId + datas (+ debtorId se tiver)
     * 2) Para cada retorno:
     *    - upsert básico na SiengeBill (sem departments_json)
     * 3) Para quem não tem departments_json no banco:
     *    - chama /v1/bills/{id}/departments-cost em paralelo (chunks)
     *    - salva departments_json + main_department_*
     * 4) Monta o retorno na mesma ordem do Sienge
     */
    async listFromSiengeWithDepartments({ costCenterId, startDate, endDate, debtorId }) {
        const filters = {
            startDate,
            endDate,
            status: 'S',
            costCenterId,
        };
        if (debtorId) filters.debtorId = debtorId;

        console.log('🌐 [Bills] listFromSiengeWithDepartments()', filters);

        // 1) sempre busca no Sienge
        const rawBills = await this.fetchAll(filters);

        if (!rawBills.length) {
            console.log('ℹ️ [Bills] Sienge não retornou nenhum título para esse filtro.');
            return [];
        }

        // 2) upsert básico de todos no banco (em paralelo por blocos)
        const pairs = [];
        const UPSERT_CHUNK = 50;

        for (let i = 0; i < rawBills.length; i += UPSERT_CHUNK) {
            const slice = rawBills.slice(i, i + UPSERT_CHUNK);

            const createdOrUpdated = await Promise.all(
                slice.map(raw => this.upsertBasic(raw, { costCenterId }))
            );

            for (let j = 0; j < slice.length; j++) {
                pairs.push({ raw: slice[j], bill: createdOrUpdated[j] });
            }
        }

        // 3) descobre quem ainda não tem departments_json
        const missing = pairs.filter(
            ({ bill }) => !bill.departments_json || !bill.departments_json.length
        );

        if (missing.length) {
            console.log(`ℹ️ [Bills] ${missing.length} títulos sem departments_json, completando via Sienge...`);

            const DEP_CHUNK = 30;
            for (let i = 0; i < missing.length; i += DEP_CHUNK) {
                const slice = missing.slice(i, i + DEP_CHUNK);

                await Promise.all(
                    slice.map(({ raw, bill }) =>
                        this.ensureDepartments(bill, raw.links || [])
                            .catch(err => {
                                console.error(`Erro ao buscar departments para bill ${bill.id}`, err);
                            })
                    )
                );
            }
        }

        // 4) carregar tudo do banco de uma vez e devolver na MESMA ordem que o Sienge mandou
        const ids = rawBills.map(b => b.id);
        const dbRows = await SiengeBill.findAll({
            where: { id: { [Op.in]: ids } },
        });

        const byId = new Map(dbRows.map(b => [b.id, b]));
        const result = ids
            .map(id => byId.get(id))
            .filter(Boolean)
            .map(b => b.toJSON());

        console.log(`✅ [Bills] listFromSiengeWithDepartments retornando ${result.length} títulos (ordem do Sienge)`);
        return result;
    }
}
