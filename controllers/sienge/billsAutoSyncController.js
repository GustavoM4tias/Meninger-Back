// controllers/sienge/billsAutoSyncController.js
import db from '../../models/sequelize/index.js';
import { runAutoSync, getCurrentRunState, ENTERPRISES_SQL } from '../../services/sienge/BillsAutoSyncService.js';

const { BillsSyncLog, BillsAutoSyncSubscription, Sequelize } = db;
const { Op } = Sequelize;

/**
 * GET /api/sienge/bills/auto-sync
 * Lista todos enterprise_cities com erp_id numérico válido,
 * + status do último auto-sync de cada um via LATERAL JOIN com bills_sync_logs.
 */
export async function listAutoSyncStatus(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const isAdmin = req.user.role === 'admin';

        const sql = `
            WITH ec_list AS (
                ${ENTERPRISES_SQL}
            )
            SELECT
                ec.id                    AS id,
                ec.erp_id                AS erp_id,
                ec.enterprise_name       AS enterprise_name,
                ec.default_city          AS default_city,
                ec.city_override         AS city_override,
                ec.company_id            AS company_id,
                ec.company_name          AS company_name,
                bsl.started_at           AS last_started_at,
                bsl.finished_at          AS last_finished_at,
                bsl.status               AS last_status,
                bsl.mode                 AS last_mode,
                bsl.total_bills          AS total_bills,
                bsl.new_bills            AS new_bills,
                bsl.updated_bills        AS updated_bills,
                bsl.installments_synced  AS installments_synced,
                bsl.expenses_updated     AS expenses_updated,
                bsl.duration_ms          AS duration_ms,
                bsl.error_message        AS error_message
            FROM ec_list ec
            LEFT JOIN LATERAL (
                SELECT *
                FROM bills_sync_logs
                WHERE enterprise_city_id = ec.id
                ORDER BY started_at DESC
                LIMIT 1
            ) bsl ON true
            ORDER BY ec.company_name NULLS LAST, ec.enterprise_name ASC;
        `;

        const rows = await db.sequelize.query(sql, {
            type: db.Sequelize.QueryTypes.SELECT,
        });

        // Filtro por cidade para não-admin
        let filtered = rows;
        if (!isAdmin) {
            const userCity = (req.user.city || '').toLowerCase();
            filtered = rows.filter(r => {
                const c = ((r.city_override || r.default_city) || '').toLowerCase();
                return c && c === userCity;
            });
        }

        return res.json({
            enterprises: filtered.map(r => ({
                id: r.id,
                erpId: r.erp_id,
                name: r.enterprise_name,
                city: r.city_override || r.default_city,
                companyId: r.company_id,
                companyName: r.company_name,
                isRecurring: !!r.is_recurring,
                recurringSince: r.recurring_since,
                recurringEnabledBy: r.recurring_enabled_by,
                lastRunAt: r.last_finished_at || r.last_started_at,
                lastStatus: r.last_status,
                lastSummary: r.last_status ? {
                    mode: r.last_mode,
                    totalBills: r.total_bills,
                    newBills: r.new_bills,
                    updatedBills: r.updated_bills,
                    installmentsSynced: r.installments_synced,
                    expensesUpdated: r.expenses_updated,
                    durationMs: r.duration_ms,
                    error: r.error_message,
                } : null,
            })),
            currentRun: getCurrentRunState(),
        });
    } catch (err) {
        console.error('[BillsAutoSync] listAutoSyncStatus error:', err);
        return res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/sienge/bills/auto-sync/run-now
 * body: {
 *   mode?: 'default' | 'full',
 *   enterpriseCityId?: number,         // sincroniza 1 CC
 *   enterpriseCityIds?: number[],      // sincroniza vários CCs específicos
 *   companyId?: number                 // sincroniza TODOS os CCs daquela company
 * }
 * Admin-only. Dispara execução manual (fire-and-forget). Prioridade do escopo:
 *   enterpriseCityIds > enterpriseCityId > companyId > (todos)
 */
export async function runAutoSyncNow(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });

        const {
            mode = 'default',
            enterpriseCityId,
            enterpriseCityIds,
            companyId,
        } = req.body || {};

        if (!['default', 'full', 'bootstrap'].includes(mode)) {
            return res.status(400).json({ error: 'mode inválido. Use default | full | bootstrap.' });
        }

        // Normaliza escopo (prioridade: array > single > company > all)
        let scopeIds = null;
        if (Array.isArray(enterpriseCityIds) && enterpriseCityIds.length) {
            scopeIds = enterpriseCityIds.map(Number).filter(Number.isFinite);
        } else if (enterpriseCityId) {
            scopeIds = [Number(enterpriseCityId)];
        }

        (async () => {
            try {
                await runAutoSync({
                    mode,
                    triggeredBy: 'manual',
                    enterpriseCityIds: scopeIds,
                    companyId: !scopeIds && companyId ? Number(companyId) : null,
                });
            } catch (err) {
                console.error('[BillsAutoSync] run-now background error:', err);
            }
        })();

        return res.status(202).json({
            message: 'Auto-sync iniciado.',
            mode,
            scope: scopeIds ? { enterpriseCityIds: scopeIds }
                : companyId ? { companyId: Number(companyId) }
                    : { all: true },
        });
    } catch (err) {
        console.error('[BillsAutoSync] runAutoSyncNow error:', err);
        return res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/sienge/bills/sync-log?enterpriseCityId=&limit=20
 * Histórico das últimas execuções (do mais recente para o mais antigo).
 */
export async function listSyncLog(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const where = {};
        if (req.query.enterpriseCityId) {
            where.enterprise_city_id = Number(req.query.enterpriseCityId);
        }
        if (req.query.costCenterId) {
            where.cost_center_id = Number(req.query.costCenterId);
        }

        const rows = await BillsSyncLog.findAll({
            where,
            order: [['started_at', 'DESC']],
            limit,
        });

        return res.json(rows);
    } catch (err) {
        console.error('[BillsAutoSync] listSyncLog error:', err);
        return res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/sienge/bills/auto-sync/recurring
 * body: { enterpriseCityIds: number[], enabled: boolean }
 *
 * Marca/desmarca CCs como recorrentes (entram no cron diário).
 * Admin-only. Bulk: aceita 1 ou N ids.
 */
export async function setRecurring(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });

        const { enterpriseCityIds, enabled } = req.body || {};

        if (!Array.isArray(enterpriseCityIds) || !enterpriseCityIds.length) {
            return res.status(400).json({ error: 'enterpriseCityIds (array) é obrigatório.' });
        }
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled (boolean) é obrigatório.' });
        }

        const ids = enterpriseCityIds.map(Number).filter(Number.isFinite);

        if (enabled) {
            const rows = ids.map(id => ({
                enterprise_city_id: id,
                enabled_by: req.user.name || req.user.email || String(req.user.id),
                enabled_at: new Date(),
            }));
            // Idempotente: ignora ids já inscritos
            await BillsAutoSyncSubscription.bulkCreate(rows, { ignoreDuplicates: true });
        } else {
            await BillsAutoSyncSubscription.destroy({
                where: { enterprise_city_id: { [Op.in]: ids } },
            });
        }

        return res.json({
            ok: true,
            enabled,
            affected: ids.length,
        });
    } catch (err) {
        console.error('[BillsAutoSync] setRecurring error:', err);
        return res.status(500).json({ error: err.message });
    }
}
