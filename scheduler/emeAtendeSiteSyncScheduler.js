// scheduler/emeAtendeSiteSyncScheduler.js
//
// Atualiza uma vez por dia o conteúdo dos empreendimentos vindo do site
// institucional para os fluxos da Eme Atende. Marketing edita o site, e no dia
// seguinte a Eme já responde com o texto novo - sem ninguém abrir a tela.
//
// 04:40 porque é fora da janela de atendimento e não disputa com os syncs
// pesados do Sienge (05:00) nem do CV (03:00).
//
// NÃO depende do gate `active` da Eme Atende: manter o snapshot fresco enquanto
// o atendimento ainda está desligado é justamente o que permite ligar sem
// surpresa. O que ele exige é fluxo com site_slug - sem isso não faz requisição.

import cron from 'node-cron';
import EmeAtendeSiteSyncService from '../services/emeAtende/EmeAtendeSiteSyncService.js';

let job = null;

function start() {
    if (job) return;
    job = cron.schedule('40 4 * * *', async () => {
        try {
            await EmeAtendeSiteSyncService.syncFlows();
        } catch (err) {
            console.warn('[eme-atende/site-sync] erro no tick:', err?.message || err);
        }
    }, { timezone: 'America/Sao_Paulo' });
    console.log('✅ emeAtendeSiteSyncScheduler agendado: 40 4 * * * (America/Sao_Paulo)');
}

export default { start };
