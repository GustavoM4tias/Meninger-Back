// services/sienge/billsService.js
import apiSienge from '../../lib/apiSienge.js';
import db from '../../models/sequelize/index.js';

const { SiengeBill, SiengeBillInstallment, Expense, Sequelize } = db;
const { Op } = Sequelize;

// ── Utilitários de rate-limit ────────────────────────────────────────────────

/** Aguarda N milissegundos */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Executa uma função assíncrona com retry automático em caso de 429 ou timeout.
 * @param {Function} fn - async () => resultado
 * @param {number} maxRetries - tentativas após a primeira falha
 * @param {number} baseDelayMs - delay base (dobra a cada tentativa)
 */
async function withRetry(fn, maxRetries = 4, baseDelayMs = 3000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.response?.status;
            const isTimeout = err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT'
                || err?.message?.includes('timeout');
            const isRetryable = status === 429 || status === 503 || isTimeout;

            if (!isRetryable || attempt === maxRetries) throw err;

            const delay = baseDelayMs * Math.pow(2, attempt); // 3s, 6s, 12s, 24s
            const reason = isTimeout ? 'timeout' : `HTTP ${status}`;
            console.warn(`⚠️  [Retry] ${reason} — aguardando ${delay / 1000}s (tentativa ${attempt + 1}/${maxRetries})...`);
            await sleep(delay);
        }
    }
}

// ── Cutoff e classificação de status ────────────────────────────────────────

/**
 * Bills com issue_date anterior a este cutoff não terão installments/expenses sincronizados.
 * Decisão de negócio (2026-05): foco é dados recentes para acompanhamento de custos.
 * Bills antigos ainda são salvos como registro histórico, mas marcados is_settled=true
 * para nunca serem re-consultados.
 */
const INSTALLMENTS_CUTOFF_DATE = '2023-01-01';

/**
 * Janela "default" do sync diário: 1º de janeiro do ano anterior até hoje.
 * Capta bills do ano corrente e do anterior — atualizações de notes/status/valor.
 */
function defaultSyncWindow() {
    const today = new Date();
    const startYear = today.getUTCFullYear() - 1;
    return {
        startDate: `${startYear}-01-01`,
        endDate:   today.toISOString().slice(0, 10),
    };
}

/**
 * Janela "full" para empreendimentos que precisam de histórico completo (bootstrap).
 * startDate é obrigatório no Sienge — usamos 2000-01-01 como piso seguro.
 */
function fullSyncWindow() {
    const endYear = new Date().getUTCFullYear() + 50;
    return {
        startDate: '2000-01-01',
        endDate:   `${endYear}-12-31`,
    };
}

/**
 * Classifica a `situation` retornada pelo Sienge em status interno do Expense.
 * Strings observadas: "Totalmente paga", "Parcialmente paga", "Em atraso", "A pagar", "Cancelada".
 * Match é case-insensitive e tolerante a acentos/variações.
 */
function classifyInstallmentSituation(situation) {
    const s = String(situation || '').toLowerCase().trim();
    if (!s) return 'open';
    if (s.includes('cancel'))            return 'cancelled';
    if (s.includes('totalmente paga'))   return 'paid';
    if (s.includes('totalmente pago'))   return 'paid';
    // "Parcialmente paga" e qualquer outro mantém open
    return 'open';
}

/**
 * A partir da lista de installments do Sienge, decide o status agregado do bill.
 * Retorna { current_status, is_settled }.
 *
 * Regras:
 *   - Todas canceladas         → 'cancelled' / settled
 *   - Todas pagas              → 'paid'      / settled
 *   - Alguma paga + outras     → 'partial'   / NÃO settled (ainda evolui)
 *   - Nenhuma paga/cancelada   → 'open'      / NÃO settled
 *   - Mistura paid + cancelled (sem open) → 'paid' / settled (cancelamentos são "fim")
 */
function aggregateBillStatus(installments) {
    if (!installments?.length) {
        return { current_status: 'open', is_settled: false };
    }

    const counts = { open: 0, paid: 0, cancelled: 0 };
    for (const inst of installments) {
        counts[classifyInstallmentSituation(inst.situation)]++;
    }

    if (counts.open === 0 && counts.paid === 0) {
        return { current_status: 'cancelled', is_settled: true };
    }
    if (counts.open === 0 && counts.cancelled === 0) {
        return { current_status: 'paid', is_settled: true };
    }
    if (counts.open === 0) {
        // só paid + cancelled
        return { current_status: 'paid', is_settled: true };
    }
    if (counts.paid > 0 || counts.cancelled > 0) {
        return { current_status: 'partial', is_settled: false };
    }
    return { current_status: 'open', is_settled: false };
}

// ────────────────────────────────────────────────────────────────────────────

export default class BillsService {
    constructor() {
        this.limit = 200;

        // cache simples em memória
        this.cache = new Map();
        this.cacheTtlMs = 5 * 60 * 1000; // 5 minutos
    }

    getCacheKey({ costCenterId, startDate, endDate, debtorId }) {
        return [
            costCenterId || '',
            startDate || '',
            endDate || '',
            debtorId || '',
        ].join('|');
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

            // ✅ NOVO: parcela atual
            installment_number: raw.installmentNumber ?? raw.installment_number ?? null,

            // ✅ já tinha
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

    /** Upsert de UM título (campos básicos) sem mexer em departments_json / creditor_json.
     *  PRESERVA os flags departments_fetched e installments_fetched no update. */
    async upsertBasic(raw, context = {}) {
        const normalized = this.normalize(raw, context);

        const existing = await SiengeBill.findByPk(raw.id);
        if (!existing) {
            return SiengeBill.create(normalized);
        }

        // Atualiza campos básicos mas NÃO sobrescreve os flags de controle
        await existing.update({
            ...normalized,
            departments_fetched: existing.departments_fetched,
            installments_fetched: existing.installments_fetched,
        });
        return existing;
    }

    /** Busca departments-cost NO Sienge por ID e salva no bill.
     *  Usa o flag departments_fetched para nunca repetir a chamada. */
    async ensureDepartments(billOrId, linksFromApi) {
        const bill = typeof billOrId === 'number'
            ? await SiengeBill.findByPk(billOrId)
            : billOrId;

        if (!bill) return null;

        // ✅ Flag de controle: se já foi buscado (mesmo que departments_json esteja vazio), pula
        if (bill.departments_fetched) {
            return bill;
        }

        const links = linksFromApi || bill.links_json || [];
        const depLink = links.find(l => l.rel === 'departmentsCost');
        if (!depLink) {
            console.warn(`⚠️ Bill ${bill.id} sem link departments-cost`);
            // Mesmo sem link, marca como fetched para não tentar de novo
            await bill.update({ departments_fetched: true });
            return bill;
        }

        // exemplo: /v1/bills/466257/departments-cost
        const relativePath = depLink.href.replace('https://api.sienge.com.br/menin/public/api', '');
        const { data } = await withRetry(() => apiSienge.get(relativePath));

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

        // ✅ Marca departments_fetched = true — nunca mais buscará na API
        await bill.update({
            departments_json: departments,
            main_department_id: main ? main.departmentId : null,
            main_department_name: main ? main.departmentName : null,
            departments_fetched: true,
        });

        return bill;
    }

    /** Busca UM creditor na API usando, se possível, o link vindo do bill */
    async fetchCreditorFromApi(creditorId, linksFromApi = []) {
        // tenta achar link rel="creditor" vindo do /v1/bills
        const credLink = linksFromApi.find(l => l.rel === 'creditor');

        let relativePath;

        if (credLink && credLink.href) {
            if (credLink.href.startsWith('http')) {
                // corta a base do tenant
                relativePath = credLink.href.replace('https://api.sienge.com.br/menin/public/api', '');
            } else {
                relativePath = credLink.href;
            }
        } else {
            // fallback padrão
            relativePath = `/v1/creditors/${creditorId}`;
        }

        const { data } = await withRetry(() => apiSienge.get(relativePath));
        return data; // mantém o payload exatamente como o Sienge manda
    }

    /**
     * Garante creditor_json preenchido para os bills do batch:
     * - só processa quem tem creditor_id e ainda NÃO tem creditor_json
     * - agrupa por creditorId pra evitar várias chamadas iguais
     * - limita concorrência (CRED_CHUNK) pra não agredir a API
     */
    async ensureCreditorsForBatch(pairs) {
        // pairs: [{ raw, bill }]
        const missingPairs = pairs.filter(({ bill }) =>
            bill.creditor_id &&
            (!bill.creditor_json || Object.keys(bill.creditor_json || {}).length === 0)
        );

        if (!missingPairs.length) {
            return;
        }

        // agrupa por creditor_id -> [ { raw, bill }, ... ]
        const byCreditorId = new Map();
        for (const pair of missingPairs) {
            const cid = pair.bill.creditor_id;
            if (!cid) continue;
            if (!byCreditorId.has(cid)) byCreditorId.set(cid, []);
            byCreditorId.get(cid).push(pair);
        }
        const creditorIds = [...byCreditorId.keys()];

        console.log(`ℹ️ [Bills] ${creditorIds.length} creditors sem cache local em creditor_json, completando via Sienge...`);

        const CRED_CHUNK = 8;

        for (let i = 0; i < creditorIds.length; i += CRED_CHUNK) {
            const slice = creditorIds.slice(i, i + CRED_CHUNK);

            await Promise.all(
                slice.map(async creditorId => {
                    const list = byCreditorId.get(creditorId) || [];
                    if (!list.length) return;

                    const first = list[0];
                    const links = first.raw.links || first.bill.links_json || [];

                    try {
                        const creditorData = await this.fetchCreditorFromApi(creditorId, links);
                        await Promise.all(
                            list.map(({ bill }) => bill.update({ creditor_json: creditorData }))
                        );
                    } catch (err) {
                        console.warn(
                            `⚠️  [Bills] Falha creditor ${creditorId}: ${err?.response?.status || err?.message}`
                        );
                    }
                })
            );
            if (i + CRED_CHUNK < creditorIds.length) await sleep(300);
        }
    }

    /**
     * Fluxo com DB-first:
     *
     * 1) Verifica se já temos todos os bills do período no banco com flags completos
     *    → Se sim, retorna do banco direto (sem chamar o Sienge)
     * 2) Se não, busca no Sienge e faz upsert dos bills novos/atualizados
     * 3) Departments: só busca no Sienge para bills com departments_fetched = false
     * 4) Creditors: só busca para bills sem creditor_json
     * 5) Installments/expenses: processados em background só para installments_fetched = false
     */
    async listFromSiengeWithDepartments({ costCenterId, startDate, endDate, debtorId }) {
        const filters = { startDate, endDate, status: 'S', costCenterId };
        if (debtorId) filters.debtorId = debtorId;

        console.log('🌐 [Bills] listFromSiengeWithDepartments()', filters);

        // ── Cache em memória (resposta imediata) ──────────────────────────────
        const cacheKey = this.getCacheKey({ costCenterId, startDate, endDate, debtorId });
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
            console.log(`💾 [Bills] cache em memória (${cached.data.length} títulos)`);
            return cached.data.map(b => ({ ...b }));
        }

        // ── DB-first: verifica se o período já está completamente processado ──
        const BLOCKED_DOC_IDS = new Set(['PCT']);

        const dbExisting = await SiengeBill.findAll({
            where: {
                cost_center_id: costCenterId,
                issue_date: { [Op.between]: [startDate, endDate] },
                ...(debtorId ? { debtor_id: debtorId } : {}),
            },
        });

        const today = new Date().toISOString().slice(0, 10);
        // DB-first quando:
        //   - Período totalmente passado (endDate < hoje), E
        //   - Todos bills têm departments fetched, E
        //   - Todos bills estão settled (paid/cancelled) OU foram anteriores ao cutoff.
        // Bills não-settled forçam re-fetch para captar mudanças de pagamento.
        const allProcessed = dbExisting.length > 0
            && dbExisting.every(b =>
                b.departments_fetched &&
                (b.is_settled || (b.issue_date && String(b.issue_date) < INSTALLMENTS_CUTOFF_DATE))
            )
            && endDate < today;

        if (allProcessed) {
            console.log(`💾 [Bills] DB-first: ${dbExisting.length} títulos já processados (período passado), sem chamada ao Sienge.`);
            const result = dbExisting
                .filter(b => !BLOCKED_DOC_IDS.has(String(b.document_identification_id || '').trim().toUpperCase()))
                .map(b => b.toJSON());
            this.cache.set(cacheKey, { ts: Date.now(), data: result });
            return result;
        }

        // ── Busca no Sienge ────────────────────────────────────────────────────
        // Chega aqui se: há bills pendentes de processamento OU período atual/futuro
        const reason = endDate >= today ? 'período aberto (pode ter novos títulos)' : 'bills pendentes de processamento';
        console.log(`🌐 [Bills] Buscando no Sienge — ${reason} (${dbExisting.length} no banco)...`);
        const rawBills = await this.fetchAll(filters);

        if (!rawBills.length) {
            console.log('ℹ️ [Bills] Sienge não retornou nenhum título para esse filtro.');
            return [];
        }

        const filteredBills = rawBills.filter(b => {
            const docId = String(b?.documentIdentificationId || '').trim().toUpperCase();
            return !BLOCKED_DOC_IDS.has(docId);
        });

        if (!filteredBills.length) {
            console.log('ℹ️ [Bills] Nenhum título após filtro (PCT removidos).');
            return [];
        }

        // Upsert básico (preserva flags de controle)
        const pairs = [];
        const UPSERT_CHUNK = 50;
        for (let i = 0; i < filteredBills.length; i += UPSERT_CHUNK) {
            const slice = filteredBills.slice(i, i + UPSERT_CHUNK);
            const saved = await Promise.all(slice.map(raw => this.upsertBasic(raw, { costCenterId })));
            for (let j = 0; j < slice.length; j++) {
                pairs.push({ raw: slice[j], bill: saved[j] });
            }
        }

        // Departments: só para quem ainda não buscou
        const missingDeps = pairs.filter(({ bill }) => !bill.departments_fetched);
        if (missingDeps.length) {
            console.log(`ℹ️ [Bills] ${missingDeps.length} títulos sem departments, buscando no Sienge...`);
            const DEP_CHUNK = 8;
            for (let i = 0; i < missingDeps.length; i += DEP_CHUNK) {
                const slice = missingDeps.slice(i, i + DEP_CHUNK);
                await Promise.all(
                    slice.map(({ raw, bill }) =>
                        this.ensureDepartments(bill, raw.links || [])
                            .catch(err => console.warn(`⚠️  [Bills] Falha departments bill ${bill.id}: ${err?.response?.status || err.message}`))
                    )
                );
                if (i + DEP_CHUNK < missingDeps.length) await sleep(300);
            }
        } else {
            console.log('✅ [Bills] Departments já processados para todos os títulos.');
        }

        // Creditors: só para quem não tem creditor_json
        await this.ensureCreditorsForBatch(pairs);

        // Carrega resultado final do banco
        const ids = filteredBills.map(b => b.id);
        const dbRows = await SiengeBill.findAll({ where: { id: { [Op.in]: ids } } });
        const byId = new Map(dbRows.map(b => [b.id, b]));
        const result = ids.map(id => byId.get(id)).filter(Boolean).map(b => b.toJSON());

        console.log(`✅ [Bills] retornando ${result.length} títulos`);
        this.cache.set(cacheKey, { ts: Date.now(), data: result });

        // Installments em background — bills não-settled dentro do cutoff
        const pendingInstallments = pairs.filter(({ bill }) =>
            !bill.is_settled &&
            (!bill.issue_date || String(bill.issue_date) >= INSTALLMENTS_CUTOFF_DATE)
        );
        if (pendingInstallments.length) {
            console.log(`ℹ️ [Bills] ${pendingInstallments.length} bills pendentes de installments (background)...`);
            this._processInstallmentsBackground(pendingInstallments);
        } else {
            console.log('✅ [Bills] Todos os bills já liquidados ou anteriores ao cutoff.');
        }

        return result;
    }

    /** Processa installments em background sem bloquear a resposta ao cliente.
     *  Aceita qualquer lista de pairs; ensureInstallmentsAndExpenses decide internamente
     *  quem é elegível (não-settled, issue_date >= cutoff). */
    async _processInstallmentsBackground(pairs) {
        const INST_CHUNK = 2;
        const DELAY_BETWEEN_MS = 800;

        for (let i = 0; i < pairs.length; i += INST_CHUNK) {
            const slice = pairs.slice(i, i + INST_CHUNK);
            await Promise.all(
                slice.map(({ bill }) =>
                    this.ensureInstallmentsAndExpenses(bill).catch(err =>
                        console.warn(`⚠️  [Bills] Falha installments bill ${bill.id}: ${err?.response?.status || err.message}`)
                    )
                )
            );
            if (i + INST_CHUNK < pairs.length) await sleep(DELAY_BETWEEN_MS);
        }

        console.log(`✅ [Bills] Processamento de installments concluído (${pairs.length} bills).`);
    }

    /** Busca parcelas do Sienge para um billId — com retry automático em 429 */
    async fetchInstallments(billId) {
        try {
            const { data } = await withRetry(() =>
                apiSienge.get(`/v1/bills/${billId}/installments`, {
                    params: { limit: 200, offset: 0 },
                })
            );
            return data.results || [];
        } catch (err) {
            if (err.response?.status === 404) return [];
            throw err;
        }
    }

    /**
     * Garante parcelas e expenses para um bill, propagando status do Sienge.
     *
     * Política de re-fetch:
     *   - Bills com issue_date < INSTALLMENTS_CUTOFF_DATE são marcados is_settled=true sem chamar API.
     *   - Bills com is_settled=true são pulados (definitivo).
     *   - Demais bills consultam /installments e atualizam status do bill e expenses.
     *
     * Retorna stats { installmentsSynced, expensesUpdated } para o log do scheduler.
     */
    async ensureInstallmentsAndExpenses(bill) {
        const billInstance = bill.update ? bill : await SiengeBill.findByPk(bill.id);
        if (!billInstance) return { installmentsSynced: 0, expensesUpdated: 0 };

        // Cutoff: bills antigos não geram expense — ficam só como registro de title histórico
        if (billInstance.issue_date && String(billInstance.issue_date) < INSTALLMENTS_CUTOFF_DATE) {
            await billInstance.update({
                installments_fetched: true,
                is_settled: true,
                current_status: 'paid', // assumido (são bills pré-2023)
                installments_synced_at: new Date(),
            });
            return { installmentsSynced: 0, expensesUpdated: 0 };
        }

        // Terminal: bill já liquidado nunca mais é re-consultado
        if (billInstance.is_settled) {
            return { installmentsSynced: 0, expensesUpdated: 0 };
        }

        const installments = await this.fetchInstallments(billInstance.id);

        if (!installments.length) {
            // Sem parcelas (ex: bills de retenção GPS/INSS): cria 1 expense direto.
            // Não há como inferir pagamento aqui — fica como 'open' até alguém marcar manualmente.
            console.warn(`⚠️ [Bills] Bill ${billInstance.id} sem parcelas — criando expense direto.`);
            await this.createExpenseFromBillDirect(billInstance);
            await billInstance.update({
                installments_fetched: true,
                installments_synced_at: new Date(),
                // sem installments não dá pra concluir status; mantém 'open' até alguém investigar
            });
            return { installmentsSynced: 0, expensesUpdated: 0 };
        }

        // Upsert das parcelas (atualiza situation/payment_type/etc. em re-syncs)
        let expensesUpdated = 0;
        for (const inst of installments) {
            const [, instCreated] = await SiengeBillInstallment.findOrCreate({
                where: {
                    bill_id: billInstance.id,
                    installment_number: inst.installmentNumber ?? null,
                },
                defaults: {
                    bill_id: billInstance.id,
                    index_id: inst.indexId ?? null,
                    base_date: inst.baseDate || null,
                    due_date: inst.dueDate || null,
                    bill_date: inst.billDate || null,
                    amount: inst.amount ?? 0,
                    installment_number: inst.installmentNumber ?? null,
                    payment_type_id: inst.paymentTypeId ?? null,
                    payment_type: inst.paymentType || null,
                    situation: inst.situation || null,
                    sent_to_bank: inst.sentToBank ?? null,
                    batch_number: inst.batchNumber ?? null,
                },
            });

            if (!instCreated) {
                // Já existia — atualiza campos que podem mudar (situation, payment, batch)
                await SiengeBillInstallment.update({
                    situation: inst.situation || null,
                    payment_type_id: inst.paymentTypeId ?? null,
                    payment_type: inst.paymentType || null,
                    sent_to_bank: inst.sentToBank ?? null,
                    batch_number: inst.batchNumber ?? null,
                    amount: inst.amount ?? 0,
                    due_date: inst.dueDate || null,
                }, {
                    where: { bill_id: billInstance.id, installment_number: inst.installmentNumber ?? null },
                });
            }
        }

        // Cria/atualiza expenses + propaga status
        expensesUpdated = await this.syncExpensesFromInstallments(billInstance, installments);

        // Agrega status do bill a partir das parcelas
        const { current_status, is_settled } = aggregateBillStatus(installments);

        await billInstance.update({
            installments_fetched: true,
            is_settled,
            current_status,
            installments_synced_at: new Date(),
        });

        return { installmentsSynced: installments.length, expensesUpdated };
    }

    /**
     * Cria 1 expense direto do bill quando Sienge não retorna installments.
     * Usa total_invoice_amount como valor e issue_date como data de competência.
     */
    async createExpenseFromBillDirect(bill) {
        const rawDate = bill.issue_date;
        if (!rawDate) {
            console.warn(`⚠️ [Bills] Bill ${bill.id} sem issue_date — não é possível criar expense.`);
            return;
        }

        const due = new Date(rawDate);
        const competenceMonth = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 1))
            .toISOString().slice(0, 10);

        const desc =
            `${bill.document_identification_id || ''} ${bill.document_number || ''}`.trim()
            || `Título ${bill.id}`;

        const [, created] = await Expense.findOrCreate({
            where: {
                bill_id: bill.id,
                installment_number: 1,
            },
            defaults: {
                cost_center_id: bill.cost_center_id,
                cost_center_name: null,
                competence_month: competenceMonth,
                due_date: rawDate,
                bill_id: bill.id,
                amount: Number(bill.total_invoice_amount) || 0,
                description: desc,
                department_id: bill.main_department_id || null,
                department_name: bill.main_department_name || null,
                installment_number: 1,
                installments_number: 1,
                status: 'open',
                paid_at: null,
            },
        });

        if (created) {
            console.log(`✅ [Bills] Expense criado (direto do bill): bill ${bill.id} competência ${competenceMonth}`);
        }
    }

    /**
     * Wrapper retrocompatível — equivale a syncEnterprise({ mode: 'full' }).
     * Mantido porque é chamado pela tela de Títulos via /bills/sync-enterprise.
     */
    async syncEnterpriseFull(costCenterId, onProgress = () => { }) {
        return this.syncEnterprise({ costCenterId, mode: 'full', onProgress });
    }

    /**
     * Sincroniza títulos de um empreendimento com política de re-sync ciente de status.
     *
     * mode:
     *   - 'default'    → janela ano-anterior → hoje (sync diário do scheduler)
     *   - 'full'       → janela 2000-01-01 → ano+50 (carga histórica / botão "Sync Tudo")
     *
     * Etapas:
     *   1. Fetch /v1/bills paginado (atualiza notes/changedDate/etc. via upsertBasic)
     *   2. Departments para bills sem departments_fetched
     *   3. Creditors para bills sem creditor_json
     *   4. Re-checa bills "potencialmente cancelados" — bills NOSSOS dentro da janela
     *      que não voltaram no fetch atual: GET /v1/bills/{id} e marca cancelled se 404
     *   5. Installments + expenses para bills elegíveis (não-settled, issue_date >= cutoff)
     *
     * @returns { totalBills, newBills, updatedBills, installmentsSynced, expensesUpdated, cancelledBills }
     */
    async syncEnterprise({ costCenterId, mode = 'default', onProgress = () => { } } = {}) {
        const BLOCKED_DOC_IDS = new Set(['PCT']);
        const id = Number(costCenterId);
        const window = mode === 'full' ? fullSyncWindow() : defaultSyncWindow();

        console.log(`🔄 [SyncEnterprise] costCenter ${id} mode=${mode} window=${window.startDate}→${window.endDate}`);
        onProgress({ phase: 'fetching', fetched: 0, total: null });

        // ── 1. Fetch paginado /v1/bills ──────────────────────────────────────
        const allRaw = [];
        let offset = 0;
        let totalCount = null;

        while (true) {
            const page = await withRetry(() =>
                this.fetchPage({
                    offset,
                    filters: {
                        costCenterId: id,
                        status: 'S',
                        startDate: window.startDate,
                        endDate:   window.endDate,
                    },
                })
            );

            if (totalCount === null) {
                totalCount = page.resultSetMetadata.count;
                onProgress({ phase: 'fetching', fetched: 0, total: totalCount });
            }

            allRaw.push(...page.results);
            offset += this.limit;

            onProgress({ phase: 'fetching', fetched: allRaw.length, total: totalCount });
            if (offset >= page.resultSetMetadata.count) break;

            await sleep(300);
        }

        const filtered = allRaw.filter(b => {
            const docId = String(b?.documentIdentificationId || '').trim().toUpperCase();
            return !BLOCKED_DOC_IDS.has(docId);
        });

        console.log(`📦 [SyncEnterprise] ${filtered.length} bills após filtro (${allRaw.length} brutos)`);

        // ── 2. Upsert básico (em lotes) ──────────────────────────────────────
        onProgress({ phase: 'upserting', done: 0, total: filtered.length });

        const pairs = [];
        let newBills = 0;
        let updatedBills = 0;
        const UPSERT_CHUNK = 50;
        const now = new Date();

        for (let i = 0; i < filtered.length; i += UPSERT_CHUNK) {
            const slice = filtered.slice(i, i + UPSERT_CHUNK);
            const saved = await Promise.all(
                slice.map(async raw => {
                    const existed = await SiengeBill.findByPk(raw.id);
                    const bill = await this.upsertBasic(raw, { costCenterId: id });
                    // Marca o último fetch — mesmo se nada mudou
                    await bill.update({ last_full_sync_at: now });
                    if (existed) updatedBills++; else newBills++;
                    return bill;
                })
            );
            for (let j = 0; j < slice.length; j++) {
                pairs.push({ raw: slice[j], bill: saved[j] });
            }
            onProgress({ phase: 'upserting', done: Math.min(i + UPSERT_CHUNK, filtered.length), total: filtered.length });
        }

        // ── 3. Departments ───────────────────────────────────────────────────
        const missingDeps = pairs.filter(({ bill }) => !bill.departments_fetched);
        onProgress({ phase: 'departments', done: 0, total: missingDeps.length });
        const DEP_CHUNK = 5;
        for (let i = 0; i < missingDeps.length; i += DEP_CHUNK) {
            const slice = missingDeps.slice(i, i + DEP_CHUNK);
            await Promise.all(
                slice.map(({ raw, bill }) =>
                    this.ensureDepartments(bill, raw.links || [])
                        .catch(err => console.warn(`⚠️ [SyncEnterprise] Dep fail ${bill.id}: ${err?.response?.status || err.message}`))
                )
            );
            onProgress({ phase: 'departments', done: Math.min(i + DEP_CHUNK, missingDeps.length), total: missingDeps.length });
            if (i + DEP_CHUNK < missingDeps.length) await sleep(500);
        }

        // ── 4. Creditors ─────────────────────────────────────────────────────
        await this.ensureCreditorsForBatch(pairs);

        // ── 5. Detecta cancelamentos: bills NOSSOS na janela que sumiram do fetch ─
        // Só rodamos isso para bills não-settled (já settled é definitivo).
        // Para evitar custo desnecessário, limitamos por window.startDate.
        let cancelledBills = 0;
        const seenIds = new Set(pairs.map(({ bill }) => bill.id));

        const ourActiveBills = await SiengeBill.findAll({
            where: {
                cost_center_id: id,
                is_settled: false,
                issue_date: { [Op.between]: [window.startDate, window.endDate] },
            },
            attributes: ['id', 'issue_date'],
        });

        const possiblyCancelled = ourActiveBills.filter(b => !seenIds.has(b.id));
        if (possiblyCancelled.length) {
            console.log(`🔍 [SyncEnterprise] ${possiblyCancelled.length} bills ativos não retornaram — verificando cancelamento...`);

            const CANCEL_CHUNK = 5;
            for (let i = 0; i < possiblyCancelled.length; i += CANCEL_CHUNK) {
                const slice = possiblyCancelled.slice(i, i + CANCEL_CHUNK);
                await Promise.all(
                    slice.map(async b => {
                        try {
                            const fresh = await withRetry(() => apiSienge.get(`/v1/bills/${b.id}`));
                            // Bill ainda existe (status pode ter mudado, ex: 'I' em inclusão);
                            // ele simplesmente saiu do filtro 'S'. Não fazemos nada aqui — fica para o próximo fetch.
                            return fresh;
                        } catch (err) {
                            if (err?.response?.status === 404) {
                                await this.markBillCancelled(b.id);
                                cancelledBills++;
                                console.log(`🚫 [SyncEnterprise] Bill ${b.id} marcado como cancelado (404 no Sienge).`);
                            } else {
                                console.warn(`⚠️ [SyncEnterprise] Falha checando bill ${b.id}: ${err?.response?.status || err.message}`);
                            }
                        }
                    })
                );
                if (i + CANCEL_CHUNK < possiblyCancelled.length) await sleep(400);
            }
        }

        // ── 6. Installments + Expenses ───────────────────────────────────────
        // Carrega estado atualizado dos bills e filtra elegíveis (não-settled, >= cutoff)
        const allIds = pairs.map(({ bill }) => bill.id);
        const refreshed = await SiengeBill.findAll({ where: { id: { [Op.in]: allIds } } });
        const eligibleForInst = refreshed.filter(b =>
            !b.is_settled &&
            (!b.issue_date || String(b.issue_date) >= INSTALLMENTS_CUTOFF_DATE)
        );

        console.log(`ℹ️ [SyncEnterprise] ${eligibleForInst.length} bills elegíveis para installments (cutoff ${INSTALLMENTS_CUTOFF_DATE})`);
        onProgress({ phase: 'installments', done: 0, total: eligibleForInst.length });

        let installmentsSynced = 0;
        let expensesUpdated = 0;
        const INST_CHUNK = 2;
        for (let i = 0; i < eligibleForInst.length; i += INST_CHUNK) {
            const slice = eligibleForInst.slice(i, i + INST_CHUNK);
            const results = await Promise.all(
                slice.map(bill =>
                    this.ensureInstallmentsAndExpenses(bill)
                        .catch(err => {
                            console.warn(`⚠️ [SyncEnterprise] Inst fail ${bill.id}: ${err?.response?.status || err.message}`);
                            return { installmentsSynced: 0, expensesUpdated: 0 };
                        })
                )
            );
            for (const r of results) {
                installmentsSynced += r.installmentsSynced || 0;
                expensesUpdated   += r.expensesUpdated   || 0;
            }
            onProgress({ phase: 'installments', done: Math.min(i + INST_CHUNK, eligibleForInst.length), total: eligibleForInst.length });
            if (i + INST_CHUNK < eligibleForInst.length) await sleep(800);
        }

        const summary = {
            mode,
            totalBills: filtered.length,
            newBills,
            updatedBills,
            cancelledBills,
            installmentsSynced,
            expensesUpdated,
        };
        console.log(`✅ [SyncEnterprise] costCenter ${id}:`, summary);
        return summary;
    }

    /**
     * Cria/atualiza Expense por parcela e propaga status (paid/cancelled/open).
     *
     * Preserva edições manuais do usuário (description, department, category):
     *   - Em create: usa departamento do bill, sem categoria.
     *   - Em update: NUNCA sobrescreve description/department/category — só status,
     *     paid_at, amount (valor é fonte da verdade do Sienge), due_date.
     *
     * @returns número de expenses afetados (criados ou atualizados)
     */
    async syncExpensesFromInstallments(bill, installments) {
        const baseDesc =
            `${bill.document_identification_id || ''} ${bill.document_number || ''}`.trim()
            || `Título ${bill.id}`;

        let affected = 0;

        for (const inst of installments) {
            // Fallback de data: dueDate → base_date → issue_date do bill
            const rawDate = inst.dueDate || inst.baseDate || bill.issue_date;
            if (!rawDate) {
                console.warn(`⚠️ [Bills] Bill ${bill.id} parcela ${inst.installmentNumber} sem data — pulando expense.`);
                continue;
            }

            const due = new Date(rawDate);
            const competenceMonth = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 1))
                .toISOString().slice(0, 10);

            const description = installments.length > 1
                ? `${baseDesc} ${inst.installmentNumber}/${installments.length}`
                : baseDesc;

            const installmentStatus = classifyInstallmentSituation(inst.situation);
            // paid_at não é exposto pelo Sienge nessa rota — usamos data da execução do sync
            const paidAt = installmentStatus === 'paid' ? new Date().toISOString().slice(0, 10) : null;

            const [exp, created] = await Expense.findOrCreate({
                where: {
                    bill_id: bill.id,
                    installment_number: inst.installmentNumber ?? 1,
                },
                defaults: {
                    cost_center_id: bill.cost_center_id,
                    cost_center_name: null,
                    competence_month: competenceMonth,
                    due_date: inst.dueDate || inst.baseDate || bill.issue_date || null,
                    bill_id: bill.id,
                    amount: inst.amount ?? 0,
                    description,
                    department_id: bill.main_department_id || null,
                    department_name: bill.main_department_name || null,
                    installment_number: inst.installmentNumber ?? 1,
                    installments_number: installments.length,
                    status: installmentStatus,
                    paid_at: paidAt,
                },
            });

            if (created) {
                affected++;
                continue;
            }

            // Update parcial: só campos que vêm do Sienge (amount/due_date/status/paid_at).
            // INVARIANTE: department_*, department_category_*, description e
            // department_overridden NUNCA entram aqui — edição manual é soberana.
            // Mesmo que department_overridden=true, o re-sync nem toca o campo.
            const updates = {
                amount: inst.amount ?? 0,
                due_date: inst.dueDate || inst.baseDate || bill.issue_date || null,
                status: installmentStatus,
            };

            // paid_at só é preenchido na primeira vez que detectarmos o pagamento
            if (installmentStatus === 'paid' && !exp.paid_at) {
                updates.paid_at = paidAt;
            }
            // Se voltou a 'open' (improvável, mas possível em estorno), limpa paid_at
            if (installmentStatus !== 'paid' && exp.paid_at) {
                updates.paid_at = null;
            }

            // Só toca o banco se houve mudança real
            const changed =
                Number(exp.amount) !== Number(updates.amount) ||
                String(exp.due_date || '') !== String(updates.due_date || '') ||
                exp.status !== updates.status ||
                String(exp.paid_at || '') !== String(updates.paid_at || '');

            if (changed) {
                await exp.update(updates);
                affected++;
            }
        }

        return affected;
    }

    /**
     * Marca o bill como cancelado e propaga para os expenses vinculados.
     * Usado quando GET /v1/bills/{id} retorna 404 (bill removido do Sienge).
     */
    async markBillCancelled(billId) {
        const bill = await SiengeBill.findByPk(billId);
        if (!bill) return;

        await bill.update({
            current_status: 'cancelled',
            is_settled: true,
            installments_synced_at: new Date(),
        });

        await Expense.update(
            { status: 'cancelled' },
            { where: { bill_id: billId } },
        );
    }

}
