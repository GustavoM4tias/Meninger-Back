// src/controllers/bulkDataController.js
import siengeDataService from '../../services/bulkData/sienge/siengeDataService.js';
import db from '../../models/sequelize/index.js';

/**
 * Recupera a última data de sync persistida no banco, baseada no MAX(updated_at)
 * dos contratos menos um buffer de segurança.
 *
 * Isso garante que o cron sobreviva a reinicializações do servidor sem perder janelas de sync.
 * O buffer de 3h cobre o intervalo do cron (1h) com folga para re-processar edge cases.
 *
 * Retorna null se não houver contratos no banco (forçará fullSync no primeiro delta).
 */
async function getLastSyncFromDb(bufferHours = 3) {
    try {
        const [[row]] = await db.sequelize.query(
            `SELECT MAX(updated_at) AS last_updated FROM contracts`
        );
        if (!row?.last_updated) return null;

        const last = new Date(row.last_updated);
        last.setHours(last.getHours() - bufferHours);
        return last;
    } catch (e) {
        console.warn('[bulkDataController] Falha ao ler MAX(updated_at):', e.message);
        return null;
    }
}

export default class SiengeController {
    constructor() {
        this.service = new siengeDataService();
        this.isRunning = false;
    }

    /** POST /api/sienge/contracts/sync/full
     *  Sincroniza TODOS os contratos do Sienge. Usar para recuperar dados perdidos. */
    async fullSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        console.log('🔄 [fullSync] Iniciando carga completa...');
        try {
            await this.service.loadAll();
            console.log('✅ [fullSync] Concluído.');
            res.send('Carga completa concluída');
        } catch (e) {
            console.error('[fullSync] Erro:', e);
            res.status(500).send('Erro na carga completa');
        } finally {
            this.isRunning = false;
        }
    }

    /** POST /api/sienge/contracts/sync/delta
     *
     *  Sincronização incremental. A janela de "since" é determinada por:
     *    1. Query param ?since=YYYY-MM-DD  (para backfill manual)
     *    2. MAX(updated_at) dos contratos no banco - 3h de buffer (persiste através de restarts)
     *    3. Fallback: início do ano corrente (quando não há nenhum contrato no banco)
     *
     *  Exemplos de uso manual para recuperar dados perdidos:
     *    POST /api/sienge/contracts/sync/delta?since=2026-01-01
     */
    async deltaSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            let since;

            // 1. Query param explícito (backfill manual)
            if (req.query?.since) {
                since = new Date(req.query.since);
                if (isNaN(since.getTime())) {
                    this.isRunning = false;
                    return res.status(400).send('Parâmetro "since" inválido. Use YYYY-MM-DD.');
                }
                console.log(`🔄 [deltaSync] Backfill manual desde: ${since.toISOString()}`);
            } else {
                // 2. Lê do banco a última vez que sincronizamos (sobrevive a restarts)
                const dbSince = await getLastSyncFromDb(3);
                if (dbSince) {
                    since = dbSince;
                    console.log(`🔄 [deltaSync] Desde DB MAX(updated_at) - 3h: ${since.toISOString()}`);
                } else {
                    // 3. Fallback: início do ano corrente
                    since = new Date(new Date().getFullYear(), 0, 1);
                    console.log(`🔄 [deltaSync] Fallback: início do ano ${since.toISOString()}`);
                }
            }

            await this.service.loadDelta(since);
            console.log('✅ [deltaSync] Concluído.');
            res.send(`Sincronização incremental concluída desde ${since.toISOString().slice(0, 10)}`);
        } catch (e) {
            console.error('[deltaSync] Erro:', e);
            res.status(500).send('Erro na sincronização incremental');
        } finally {
            this.isRunning = false;
        }
    }

    /** GET /api/sienge/contracts/sync/status
     *  Informa o estado atual do sync (útil para diagnóstico). */
    async syncStatus(req, res) {
        try {
            const [[row]] = await db.sequelize.query(`
                SELECT
                    COUNT(*)                                               AS total_contracts,
                    COUNT(*) FILTER (WHERE situation = 'Cancelado')        AS total_cancelled,
                    MAX(updated_at)                                        AS last_sync_at,
                    MIN(updated_at)                                        AS first_sync_at,
                    COUNT(DISTINCT enterprise_id)                          AS total_enterprises
                FROM contracts
            `);
            res.json({
                isRunning: this.isRunning,
                db: {
                    totalContracts:   Number(row.total_contracts),
                    totalCancelled:   Number(row.total_cancelled),
                    totalEnterprises: Number(row.total_enterprises),
                    lastSyncAt:       row.last_sync_at,
                    firstSyncAt:      row.first_sync_at,
                },
                nextDeltaSince: (await getLastSyncFromDb(3))?.toISOString() ?? 'início do ano (sem contratos)',
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
}
