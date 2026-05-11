// services/sienge/BillsAutoSyncService.js
//
// Orquestra o auto-sync diário de bills por empreendimento.
// - Itera por todo enterprise_city com erp_id IS NOT NULL
// - Sequencial (não paralelo) — evita rate-limit do Sienge
// - Registra cada execução em bills_sync_logs e atualiza coluna resumo em enterprise_cities

import db from '../../models/sequelize/index.js';
import BillsService from './billsService.js';

const { EnterpriseCity, BillsSyncLog, Sequelize } = db;
const { Op } = Sequelize;

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
 * Roda o auto-sync para todos os empreendimentos ativos (erp_id IS NOT NULL).
 *
 * @param {object} opts
 * @param {'default'|'full'|'bootstrap'} opts.mode      janela aplicada — default = ano-anterior→hoje, full = histórico completo
 * @param {'cron'|'manual'}              opts.triggeredBy  origem do disparo
 * @param {number|null}                  opts.enterpriseCityId  se informado, roda só nesse empreendimento
 */
export async function runAutoSync({ mode = 'default', triggeredBy = 'cron', enterpriseCityId = null } = {}) {
    if (currentRun?.running) {
        console.warn('⚠️ [BillsAutoSync] Já há uma execução em andamento. Abortando nova chamada.');
        return { skipped: true, reason: 'already_running' };
    }

    const where = { erp_id: { [Op.ne]: null } };
    if (enterpriseCityId) where.id = enterpriseCityId;

    const enterprises = await EnterpriseCity.findAll({
        where,
        attributes: ['id', 'erp_id', 'enterprise_name'],
        order: [['enterprise_name', 'ASC']],
    });

    if (!enterprises.length) {
        console.warn('⚠️ [BillsAutoSync] Nenhum empreendimento com erp_id encontrado.');
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

        await ec.update({
            auto_sync_last_status: 'running',
            auto_sync_last_run_at: new Date(),
        });

        const start = Date.now();
        try {
            const result = await service.syncEnterprise({ costCenterId, mode });

            const finishedAt = new Date();
            await log.update({
                finished_at: finishedAt,
                status: 'success',
                total_bills: result.totalBills,
                new_bills: result.newBills,
                updated_bills: result.updatedBills,
                installments_synced: result.installmentsSynced,
                expenses_updated: result.expensesUpdated,
                duration_ms: Date.now() - start,
            });

            await ec.update({
                auto_sync_last_status: 'success',
                auto_sync_last_run_at: finishedAt,
                auto_sync_last_summary: result,
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

            await ec.update({
                auto_sync_last_status: 'error',
                auto_sync_last_run_at: new Date(),
                auto_sync_last_summary: { error: String(err?.message || err).slice(0, 500) },
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
