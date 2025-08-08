import siengeDataService from '../../services/bulkData/sienge/siengeDataService.js'; 

const state = {
    lastRunAt: null
};

export default class SiengeController {
    constructor() {
        this.service = new siengeDataService();
        this.isRunning = false;
    }

    /** Rota POST /api/sienge/sync/full */
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

    /** Rota POST /api/sienge/sync/delta */
    async deltaSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        try {
            const since = state.lastRunAt || new Date(Date.now() - 24 * 3600 * 1000);
            await this.service.loadDelta(since);
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
