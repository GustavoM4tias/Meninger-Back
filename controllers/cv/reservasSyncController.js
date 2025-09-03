// src/controllers/cv/reservasSyncController.js
import ReservaSyncService from '../../services/bulkData/cv/ReservaSyncService.js';

const state = { lastRunAt: null };

export default class CvReservasSyncController {
    constructor() {
        this.service = new ReservaSyncService();
        this.isRunning = false;
    }

    async fullSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            const stats = await this.service.loadAll();
            state.lastRunAt = new Date();
            res.send(`Reservas FULL — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro no FULL de reservas');
        } finally {
            this.isRunning = false;
        }
    }

    async deltaSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            const since = state.lastRunAt || null; // primeira vez usa lookback default no service
            const stats = await this.service.loadDelta(since);
            state.lastRunAt = new Date();
            res.send(`Reservas DELTA — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged} | falhas=${stats.failed}`);
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro no DELTA de reservas');
        } finally {
            this.isRunning = false;
        }
    }
}
