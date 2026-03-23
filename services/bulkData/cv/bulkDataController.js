// src/controllers/cv/bulkDataController.js
import LeadSyncService from './LeadSyncService.js';
import LeadCancelReasonSyncService from './LeadCancelReasonSyncService.js';
import db from '../../../models/sequelize/index.js';

const state = { lastRunAt: null };

export default class CvLeadSyncController {
    constructor() {
        this.service = new LeadSyncService();
        this.cancelReasonService = new LeadCancelReasonSyncService();
        this.isRunning = false;
        this.cancelReasonRunning = false;
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

    async cancelReasonSync(req, res) {
        if (this.cancelReasonRunning) return res.status(429).send('Já em execução');
        this.cancelReasonRunning = true;
        try {
            await this.cancelReasonService.sync();
            res.send('Motivos de cancelamento atualizados');
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro ao atualizar motivos de cancelamento');
        } finally {
            this.cancelReasonRunning = false;
        }
    }

}
