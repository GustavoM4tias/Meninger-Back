import { syncObstitToLandValue  } from '../../services/bulkData/external/syncLandService.js'; 

export default class LandDataController {
    constructor() {
        this.isRunning = false;
        this.run = this.run.bind(this);
    }

    async run(req, res) {
        if (this.isRunning) {
            console.log('[OBSTIT] Execução já em andamento, abortando...');
            return res?.status?.(429)?.send?.('Já em execução');
        }

        this.isRunning = true;
        try {
            const result = await syncObstitToLandValue();
            return res?.status?.(200)?.send?.(result);
        } catch (e) {
            console.error('[OBSTIT] Erro inesperado', e);
            return res?.status?.(500)?.send?.('Erro na sincronização OBSTIT');
        } finally {
            this.isRunning = false;
        }
    }
}