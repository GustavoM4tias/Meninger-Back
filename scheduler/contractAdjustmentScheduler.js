// scheduler/contractAdjustmentScheduler.js
//
// Vigilância dos AJUSTES CONTÁBEIS do Faturamento.
//
// A máscara é criada sobre uma foto do contrato; o Sienge é ressincronizado
// todo dia (fullSync 02:30) e pode reescrever justamente o dado corrigido.
// Roda depois disso e confronta cada ajuste com a origem atual:
//   • origem mudou            → status needs_review + notificação aos admins.
//     A máscara CONTINUA valendo — o número não se mexe sozinho.
//   • origem virou o ajustado → resolve sozinho, em silêncio (nada a revisar).
import cron from 'node-cron';
import { checkAdjustmentDrift } from '../services/comercial/contractAdjustmentsService.js';

class ContractAdjustmentScheduler {
    constructor() {
        this.task = null;
        // 03:40: depois do fullSync (02:30) e da vigilância de fechamento (03:30).
        this.cronExp = process.env.CONTRACT_ADJUSTMENT_WATCH_CRON_EXPRESSION || '40 3 * * *';
    }

    start() {
        if (this.task) this.task.stop();
        this.task = cron.schedule(this.cronExp, async () => {
            try {
                const r = await checkAdjustmentDrift({ notify: true });
                console.log(`🔎 [ContractAdjust] Vigilância: ${r.checked} ajuste(s) conferido(s), ${r.needsReview} a revisar, ${r.autoResolved} resolvido(s) sozinho(s).`);
            } catch (err) {
                console.error('❌ [ContractAdjust] Vigilância falhou:', err.message);
            }
        });
        console.log(`✅ Vigilância de ajustes contábeis configurada: ${this.cronExp}`);
    }

    stop() {
        if (this.task) this.task.stop();
    }
}

export default new ContractAdjustmentScheduler();
