// controllers/cv/precadastrosSyncController.js
import PrecadastroSyncService from '../../services/bulkData/cv/PrecadastroSyncService.js';
import { markRunning, markFinished } from '../../services/bulkData/cv/syncState.js';

const JOB = 'cv_precadastros';

export default class CvPrecadastrosSyncController {
    constructor() {
        this.service = new PrecadastroSyncService();
        this.isRunning = false;
    }

    async fullSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        await markRunning(JOB);
        try {
            const stats = await this.service.loadAll();
            await markFinished(JOB, { status: 'ok', stats });
            res.send(`Precadastros FULL — ${JSON.stringify(stats)}`);
        } catch (e) {
            console.error(e);
            await markFinished(JOB, { status: 'error', message: e?.message || String(e) });
            res.status(500).send('Erro no FULL de pré-cadastros');
        } finally {
            this.isRunning = false;
        }
    }

    async deltaSync(req, res) {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;
        await markRunning(JOB);
        try {
            const stats = await this.service.loadDelta();
            await markFinished(JOB, { status: 'ok', stats });
            res.send(`Precadastros DELTA — ${JSON.stringify(stats)}`);
        } catch (e) {
            console.error(e);
            await markFinished(JOB, { status: 'error', message: e?.message || String(e) });
            res.status(500).send('Erro no DELTA de pré-cadastros');
        } finally {
            this.isRunning = false;
        }
    }
}
