// src/controllers/sienge/billsController.js
import BillsService from '../../services/sienge/billsService.js';

export default class BillsController {
    constructor() {
        this.service = new BillsService();
        this.isRunning = false;
    }

    /** GET /api/sienge/bills?costCenterId=80001&startDate=2025-08-01&endDate=2025-10-31&debtorId=80 */
    list = async (req, res) => {
        try {
            const { costCenterId, startDate, endDate, debtorId } = req.query;
            if (!costCenterId) {
                return res.status(400).json({ error: 'costCenterId é obrigatório' });
            }

            const rows = await this.service.listFromSiengeWithDepartments({
                costCenterId: Number(costCenterId),
                startDate,
                endDate,
                debtorId: debtorId ? Number(debtorId) : undefined,
            });

            return res.json(rows);
        } catch (e) {
            console.error('❌ [BillsController] Erro ao listar títulos', e);

            const status = e.response?.status || 500;
            const providerMsg =
                e.response?.data?.clientMessage ||
                e.response?.data?.developerMessage;

            return res.status(status).json({
                error: providerMsg || 'Erro ao listar títulos do Sienge',
            });
        }
    }
    
    /** (opcional) POST /api/sienge/bills/sync – você pode até aposentar */
    sync = async (req, res) => {
        if (this.isRunning) return res.status(429).send('Já em execução');
        this.isRunning = true;

        try {
            const { costCenterId, startDate, endDate, debtorId } = req.body;

            if (!costCenterId || !startDate || !endDate) {
                return res.status(400).json({ error: 'costCenterId, startDate e endDate são obrigatórios' });
            }

            const count = await this.service.syncBills({
                costCenterId,
                startDate,
                endDate,
                debtorId,
            });

            res.json({ synced: count });
        } catch (e) {
            console.error(e);
            res.status(500).send('Erro ao sincronizar títulos do Sienge');
        } finally {
            this.isRunning = false;
        }
    }

}
