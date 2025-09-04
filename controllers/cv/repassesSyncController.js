// src/controllers/cv/repassesSyncController.js
import RepasseSyncService from '../../services/bulkData/cv/RepasseSyncService.js';

const state = { lastRunAt: null };

export default class CvRepassesSyncController {
    constructor() {
        this.service = new RepasseSyncService();
        this.isRunning = false;
    }

    async fullSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            const stats = await this.service.loadAll();
            state.lastRunAt = new Date();
            console.log(`[Repasses][FULL] total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged}`);
            res.send(`Carga inicial de repasses concluída — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged}`);
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro na carga inicial de repasses');
        } finally {
            this.isRunning = false;
        }
    }

    async deltaSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            const stats = await this.service.loadDelta();
            state.lastRunAt = new Date();
            console.log(`[Repasses][DELTA] total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged}`);
            res.send(`Sincronização incremental de repasses concluída — total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged}`);
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro na sincronização incremental de repasses');
        } finally {
            this.isRunning = false;
        }
    }
}
