// src/controllers/cv/reservasSyncController.js
import ReservaSyncService from '../../services/bulkData/cv/ReservaSyncService.js';
import ReservaFullSweepService from '../../services/bulkData/cv/ReservaFullSweepService.js';
import { getLastRunAt, markRunning, markFinished } from '../../services/bulkData/cv/syncState.js';

const JOB = 'cv_reservas';
const JOB_SWEEP = 'cv_reservas_sweep';

export default class CvReservasSyncController {
    constructor() {
        this.service = new ReservaSyncService();
        this.sweepService = new ReservaFullSweepService();
        this.isRunning = false;
        this.isSweeping = false;
    }

    async fullSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        await markRunning(JOB);
        try {
            const stats = await this.service.loadAll();
            await markFinished(JOB, { status: 'ok', stats });
            res.send(`Reservas FULL — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        } catch (e) {
            console.error(e);
            await markFinished(JOB, { status: 'error', message: e?.message || String(e) });
            res.status(500).send('Erro no FULL de reservas');
        } finally {
            this.isRunning = false;
        }
    }

    async deltaSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        await markRunning(JOB);
        try {
            const since = await getLastRunAt(JOB); // sobrevive a restarts
            const stats = await this.service.loadDelta(since);
            await markFinished(JOB, { status: 'ok', stats });
            res.send(`Reservas DELTA — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        } catch (e) {
            console.error(e);
            await markFinished(JOB, { status: 'error', message: e?.message || String(e) });
            res.status(500).send('Erro no DELTA de reservas');
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * VARREDURA ID-A-ID (manual).
     * Bate em /v1/comercial/reservas/{id} para [fromId..toId].
     * Garante achar reservas em estado terminal que a listagem global oculta.
     *
     * Body opcional (JSON):
     *   { "fromId": 1, "toId": 6500, "skipDead": true }
     */
    async fullSweep(req, res) {
        if (this.isSweeping) return res.status(429).send('Sweep já em execução');
        this.isSweeping = true;
        await markRunning(JOB_SWEEP);
        try {
            const opts = {
                fromId:   req.body?.fromId ? Number(req.body.fromId) : undefined,
                toId:     req.body?.toId   ? Number(req.body.toId)   : undefined,
                ids:      Array.isArray(req.body?.ids) ? req.body.ids : undefined,
                skipDead: req.body?.skipDead !== false, // default true
            };
            const stats = await this.sweepService.run(opts);
            await markFinished(JOB_SWEEP, { status: 'ok', stats });
            res.json({
                ok: true,
                message: `Sweep concluído em ${stats.took_s}s — ` +
                         `varridos=${stats.total_scanned} | criados=${stats.created} | ` +
                         `atualizados=${stats.updated} | mantidos=${stats.unchanged} | ` +
                         `404=${stats.not_found} | falhas=${stats.failed}`,
                stats,
            });
        } catch (e) {
            console.error('[Sweep] erro:', e);
            await markFinished(JOB_SWEEP, { status: 'error', message: e?.message || String(e) });
            res.status(500).json({ ok: false, error: e?.message || String(e) });
        } finally {
            this.isSweeping = false;
        }
    }
}
