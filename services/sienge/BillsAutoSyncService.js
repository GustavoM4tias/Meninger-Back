// services/sienge/BillsAutoSyncService.js
//
// Orquestra o auto-sync diário de bills por empreendimento.
// - Itera por todos os enterprise_cities com erp_id válido
// - Sequencial (não paralelo) — evita rate-limit do Sienge
// - Registra cada execução em bills_sync_logs

import db from '../../models/sequelize/index.js';
import BillsService from './billsService.js';

const { BillsSyncLog } = db;

/**
 * SQL que retorna a lista de empreendimentos elegíveis ao auto-sync, anexando
 * companyId/companyName para que a tela agrupe por empresa.
 *
 * Filtro `source='erp'`: só processa registros que vieram do sync de cost-centers
 * do Sienge. CRM-only não tem idCompany e não faz sentido sincronizar bills.
 * Bônus: source='erp' tem unique(source, erp_id) → não há duplicatas.
 *
 * companyId: extraído de raw_payload->>'idCompany' (sync /v1/cost-centers)
 *
 * companyName fallback em cascata:
 *   1. raw_payload->>'companyName' do próprio cost-center
 *   2. raw_payload->>'companyName' de OUTRO cost-center com a mesma companyId
 *   3. último payment_launches.company_name da mesma companyId
 *   4. null → frontend mostra "Empresa #{companyId}"
 */
export const ENTERPRISES_SQL = `
    SELECT
        ec.id,
        ec.erp_id,
        -- nome de exibição: override admin (cost_center_overrides) tem prioridade
        COALESCE(
            (SELECT cco.display_name FROM cost_center_overrides cco
             WHERE cco.cost_center_id = ec.erp_id::int),
            ec.enterprise_name
        ) AS enterprise_name,
        ec.default_city,
        ec.city_override,
        NULLIF(ec.raw_payload->>'idCompany','')::int AS company_id,
        COALESCE(
            NULLIF(ec.raw_payload->>'companyName',''),
            (
                SELECT NULLIF(ec2.raw_payload->>'companyName','')
                FROM enterprise_cities ec2
                WHERE ec2.source = 'erp'
                  AND NULLIF(ec2.raw_payload->>'idCompany','')::int
                      = NULLIF(ec.raw_payload->>'idCompany','')::int
                  AND NULLIF(ec2.raw_payload->>'companyName','') IS NOT NULL
                LIMIT 1
            ),
            (
                SELECT pl.company_name
                FROM payment_launches pl
                WHERE pl.company_id = NULLIF(ec.raw_payload->>'idCompany','')::int
                  AND pl.company_name IS NOT NULL
                ORDER BY pl.updated_at DESC NULLS LAST
                LIMIT 1
            )
        ) AS company_name,
        EXISTS (
            SELECT 1 FROM bills_auto_sync_subscriptions sub
            WHERE sub.enterprise_city_id::bigint = ec.id::bigint
        ) AS is_recurring,
        (
            SELECT sub.enabled_at FROM bills_auto_sync_subscriptions sub
            WHERE sub.enterprise_city_id::bigint = ec.id::bigint
            LIMIT 1
        ) AS recurring_since,
        (
            SELECT sub.enabled_by FROM bills_auto_sync_subscriptions sub
            WHERE sub.enterprise_city_id::bigint = ec.id::bigint
            LIMIT 1
        ) AS recurring_enabled_by
    FROM enterprise_cities ec
    WHERE ec.source = 'erp'
      AND ec.erp_id IS NOT NULL
      AND ec.erp_id ~ '^[0-9]+$'
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Pausa entre empreendimentos para suavizar carga na API Sienge
const DELAY_BETWEEN_ENTERPRISES_MS = 2000;

/**
 * Estado em memória do auto-sync em curso. Permite à UI de monitoramento exibir
 * progresso em tempo real (perdido em restart, mas o log persistido cobre histórico).
 */
let currentRun = null;

export function getCurrentRunState() {
    return currentRun ? { ...currentRun } : null;
}

/**
 * Roda o auto-sync para empreendimentos.
 *
 * Escopo (prioridade): enterpriseCityIds > companyId > (todos com erp_id válido).
 *
 * @param {object} opts
 * @param {'default'|'full'|'bootstrap'} opts.mode
 * @param {'cron'|'manual'}              opts.triggeredBy
 * @param {number[]|null}                opts.enterpriseCityIds  lista específica de enterprise_cities.id
 * @param {number|null}                  opts.companyId          todos os CCs daquela company
 */
export async function runAutoSync({
    mode = 'default',
    triggeredBy = 'cron',
    enterpriseCityIds = null,
    companyId = null,
    includeNonRecurring = false,
} = {}) {
    if (currentRun?.running) {
        console.warn('⚠️ [BillsAutoSync] Já há uma execução em andamento. Abortando nova chamada.');
        return { skipped: true, reason: 'already_running' };
    }

    // Monta filtro de escopo via CTE.
    // Usamos IN(:array) — o Sequelize expande corretamente para IN (1,2,3) com replacements.
    //
    // Regra de escopo:
    //   - enterpriseCityIds[]  → CCs específicos
    //   - companyId            → todos os CCs daquela empresa
    //   - SEM escopo           → APENAS recorrentes (mesmo comportamento de cron e "rodar todos" manual)
    //
    // Para rodar literalmente TODOS os CCs (incluindo não-recorrentes), passe a flag
    // explícita includeNonRecurring=true. Útil só para casos especiais (carga inicial).
    let scopeFilter = '';
    const replacements = {};

    if (enterpriseCityIds?.length) {
        scopeFilter = `WHERE id IN (:enterpriseCityIds)`;
        replacements.enterpriseCityIds = enterpriseCityIds;
    } else if (companyId) {
        scopeFilter = `WHERE company_id = :companyId`;
        replacements.companyId = companyId;
    } else if (!includeNonRecurring) {
        scopeFilter = `WHERE is_recurring = true`;
    }

    const sql = `
        WITH ec_list AS (${ENTERPRISES_SQL})
        SELECT * FROM ec_list
        ${scopeFilter}
        ORDER BY enterprise_name
    `;

    const enterprises = await db.sequelize.query(sql, {
        type: db.Sequelize.QueryTypes.SELECT,
        replacements,
    });

    if (!enterprises.length) {
        console.warn('⚠️ [BillsAutoSync] Nenhum empreendimento encontrado.');
        return { skipped: true, reason: 'no_enterprises' };
    }

    currentRun = {
        running: true,
        mode,
        triggeredBy,
        startedAt: new Date().toISOString(),
        total: enterprises.length,
        done: 0,
        current: null,
        successes: 0,
        failures: 0,
    };

    console.log(`🟦 [BillsAutoSync] Iniciando — ${enterprises.length} empreendimentos | mode=${mode} | trigger=${triggeredBy}`);

    const service = new BillsService();
    const aggregate = {
        totalEnterprises: enterprises.length,
        successes: 0,
        failures: 0,
        bills: 0,
        installments: 0,
        expensesUpdated: 0,
        cancelledBills: 0,
    };

    for (const ec of enterprises) {
        const costCenterId = Number(ec.erp_id);
        if (!Number.isFinite(costCenterId)) {
            console.warn(`⚠️ [BillsAutoSync] erp_id inválido em enterprise_city ${ec.id} (${ec.enterprise_name})`);
            continue;
        }

        currentRun.current = { enterpriseCityId: ec.id, name: ec.enterprise_name, costCenterId };

        const log = await BillsSyncLog.create({
            enterprise_city_id: ec.id,
            cost_center_id: costCenterId,
            mode,
            started_at: new Date(),
            status: 'running',
            triggered_by: triggeredBy,
        });

        const start = Date.now();
        try {
            const result = await service.syncEnterprise({ costCenterId, mode });

            await log.update({
                finished_at: new Date(),
                status: 'success',
                total_bills: result.totalBills,
                new_bills: result.newBills,
                updated_bills: result.updatedBills,
                installments_synced: result.installmentsSynced,
                expenses_updated: result.expensesUpdated,
                duration_ms: Date.now() - start,
            });

            aggregate.successes++;
            aggregate.bills          += result.totalBills        || 0;
            aggregate.installments   += result.installmentsSynced || 0;
            aggregate.expensesUpdated += result.expensesUpdated   || 0;
            aggregate.cancelledBills += result.cancelledBills    || 0;
            currentRun.successes++;
        } catch (err) {
            console.error(`❌ [BillsAutoSync] Falha em ${ec.enterprise_name} (${costCenterId}):`, err?.message || err);

            await log.update({
                finished_at: new Date(),
                status: 'error',
                duration_ms: Date.now() - start,
                error_message: String(err?.message || err).slice(0, 2000),
            });

            aggregate.failures++;
            currentRun.failures++;
        }

        currentRun.done++;

        // Pausa entre empreendimentos para suavizar a carga
        if (currentRun.done < enterprises.length) {
            await sleep(DELAY_BETWEEN_ENTERPRISES_MS);
        }
    }

    currentRun.running = false;
    currentRun.finishedAt = new Date().toISOString();
    console.log(`✅ [BillsAutoSync] Concluído:`, aggregate);

    const finalState = { ...currentRun, aggregate };
    // Mantém o estado por mais alguns minutos para a UI poder ler o resultado, depois limpa
    setTimeout(() => { if (!currentRun?.running) currentRun = null; }, 5 * 60 * 1000);

    return aggregate;
}
