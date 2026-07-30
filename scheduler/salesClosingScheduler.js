// scheduler/salesClosingScheduler.js
//
// Vigilância dos meses de vendas CONSOLIDADOS: roda depois do fullSync diário
// de contratos (02:30) e compara a fotografia dos insumos de cada fechamento
// com o estado atual — mudança vira divergência registrada + notificação aos
// admins. O snapshot consolidado nunca é alterado automaticamente.
import cron from 'node-cron';
import { checkDivergences } from '../services/comercial/salesClosingService.js';

class SalesClosingScheduler {
    constructor() {
        this.task = null;
        this.cronExp = process.env.SALES_CLOSING_WATCH_CRON_EXPRESSION || '30 3 * * *';
    }

    start() {
        if (this.task) this.task.stop();
        this.task = cron.schedule(this.cronExp, async () => {
            try {
                const { checked, newDivergences } = await checkDivergences({ notify: true });
                console.log(`🔎 [SalesClosing] Vigilância: ${checked} mês(es) conferido(s), ${newDivergences} divergência(s) nova(s).`);
            } catch (err) {
                console.error('❌ [SalesClosing] Vigilância falhou:', err.message);
            }
        });
        console.log(`✅ Vigilância de fechamentos de vendas configurada: ${this.cronExp}`);
    }

    stop() {
        if (this.task) this.task.stop();
    }
}

export default new SalesClosingScheduler();
