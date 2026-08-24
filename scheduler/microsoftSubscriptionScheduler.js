// scheduler/microsoftSubscriptionScheduler.js
//
// Renova as assinaturas de mudança do Graph antes de vencerem.
//
// Assinatura de e-mail e de calendário dura ~3 dias e morre em SILÊNCIO: o
// Office simplesmente para de receber notificação, sem erro nenhum em lugar
// nenhum. Sem este scheduler, o recurso funcionaria por três dias e depois
// pareceria que "nunca funcionou".
//
// Roda de hora em hora e renova o que vence nas próximas 12h — sobra muita
// tentativa antes do prazo. Assinatura que a Microsoft já apagou é recriada em
// vez de renovada, porque renovar o que não existe nunca passa.

import cron from 'node-cron';
import subscriptionService from '../services/microsoft/MicrosoftSubscriptionService.js';

const CRON = '17 * * * *'; // minuto 17 para não brigar com a virada de hora

async function rodar() {
    const estado = subscriptionService.status();
    if (!estado.possivel) return; // sem URL pública não há o que renovar

    const r = await subscriptionService.renewExpiring();
    if (r.verificadas) {
        console.log(`🔔 [GraphSubs] ${r.verificadas} verificada(s): ${r.renovadas} renovada(s), `
                  + `${r.recriadas} recriada(s), ${r.falhas} falha(s).`);
    }
}

const microsoftSubscriptionScheduler = {
    start() {
        const estado = subscriptionService.status();
        if (!estado.possivel) {
            console.log(`ℹ️  Assinaturas do Graph desligadas: ${estado.motivo}`);
            return;
        }
        cron.schedule(CRON, () => {
            rodar().catch(err => console.error('❌ [GraphSubs]', err.message));
        }, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });

        console.log(`✅ Renovação de assinaturas do Graph agendada: ${CRON}`);
    },
    runNow: rodar,
};

export default microsoftSubscriptionScheduler;
