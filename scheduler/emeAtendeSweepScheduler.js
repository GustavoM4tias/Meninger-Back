// scheduler/emeAtendeSweepScheduler.js
//
// Rede de segurança do debounce da Eme Atende. O timer que agenda a resposta da
// IA vive na memória da instância que recebeu o webhook: se ela reinicia (deploy)
// ou se o próximo evento cai em outra réplica, aquela rodada se perdia e o lead
// ficava sem resposta. Aqui o prazo é lido do banco (conversations.ai_due_at) e
// disparado por quem estiver de pé.
//
// Tick de 15s: o debounce padrão é 8s, então esperar 1 minuto (menor granularidade
// de cron comum) deixaria a resposta lenta demais pra uma conversa de WhatsApp.
// O disparo é disputado por UPDATE condicional, então o tick de N réplicas não
// gera resposta duplicada.

import cron from 'node-cron';
import EmeAtendeSettingsService from '../services/emeAtende/EmeAtendeSettingsService.js';
import EmeAtendeConversationEngine from '../services/emeAtende/EmeAtendeConversationEngine.js';

let job = null;

function start() {
    if (job) return;
    job = cron.schedule('*/15 * * * * *', async () => {
        try {
            const cfg = await EmeAtendeSettingsService.getConfig();
            if (!cfg.active) return;   // desligada: nem consulta conversas
            const { due, fired } = await EmeAtendeConversationEngine.sweepDueRounds();
            if (fired) console.log(`[eme-atende/sweep] ${fired} rodada(s) de ${due} vencida(s) disparada(s).`);
        } catch (err) {
            console.warn('[eme-atende/sweep] erro:', err?.message || err);
        }
    });
    console.log('✅ emeAtendeSweepScheduler iniciado (tick 15s; só age com a Eme Atende ativa).');
}

export default { start };
