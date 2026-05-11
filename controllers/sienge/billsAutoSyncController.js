// controllers/sienge/billsAutoSyncController.js
import db from '../../models/sequelize/index.js';
import { runAutoSync, getCurrentRunState } from '../../services/sienge/BillsAutoSyncService.js';

const { EnterpriseCity, BillsSyncLog, Sequelize } = db;
const { Op } = Sequelize;

/**
 * GET /api/sienge/bills/auto-sync
 * Lista empreendimentos com status do último auto-sync.
 */
export async function listAutoSyncStatus(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });

        const isAdmin = req.user.role === 'admin';
        const where = { erp_id: { [Op.ne]: null } };

        const rows = await EnterpriseCity.findAll({
            where,
            attributes: [
                'id', 'erp_id', 'enterprise_name', 'default_city', 'city_override',
                'auto_sync_last_run_at', 'auto_sync_last_status', 'auto_sync_last_summary',
            ],
            order: [['enterprise_name', 'ASC']],
        });

        // Filtra por cidade para não-admin
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
                lastRunAt: r.auto_sync_last_run_at,
                lastStatus: r.auto_sync_last_status,
                lastSummary: r.auto_sync_last_summary,
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
 * body: { enterpriseCityId?: number, mode?: 'default'|'full' }
 * Admin-only. Dispara execução manual (fire-and-forget).
 */
export async function runAutoSyncNow(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Usuário não autenticado.' });
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores.' });

        const { enterpriseCityId, mode = 'default' } = req.body || {};

        if (!['default', 'full', 'bootstrap'].includes(mode)) {
            return res.status(400).json({ error: 'mode inválido. Use default | full | bootstrap.' });
        }

        // Dispara em background — responde imediato
        (async () => {
            try {
                await runAutoSync({
                    mode,
                    triggeredBy: 'manual',
                    enterpriseCityId: enterpriseCityId ? Number(enterpriseCityId) : null,
                });
            } catch (err) {
                console.error('[BillsAutoSync] run-now background error:', err);
            }
        })();

        return res.status(202).json({ message: 'Auto-sync iniciado.', mode, enterpriseCityId: enterpriseCityId ?? null });
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
