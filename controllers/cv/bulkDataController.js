// src/controllers/cv/bulkDataController.js
import cvDataService from '../../services/bulkData/cv/cvDataService.js';

const state = { lastRunAt: null };

export default class CvLeadSyncController {
    constructor() {
        this.service = new cvDataService();
        this.isRunning = false;
    }

    async fullSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            await this.service.loadAll();
            state.lastRunAt = new Date();
            res.send('Carga inicial concluída');
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro na carga inicial');
        } finally {
            this.isRunning = false;
        }
    }

    async deltaSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            await this.service.loadDelta();
            state.lastRunAt = new Date();
            res.send('Sincronização incremental concluída');
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro na sincronização incremental');
        } finally {
            this.isRunning = false;
        }
    }
}
