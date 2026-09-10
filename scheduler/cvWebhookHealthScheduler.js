// scheduler/cvWebhookHealthScheduler.js
//
// O vigia do silêncio dos webhooks do CV. Igual aos outros crons de CV: este
// módulo expõe só o TRABALHO (`run`); quem agenda, liga, desliga e grava o
// resultado é services/cv/cvCronManager.js, com a regra vindo de cv_sync_jobs e
// da tela CV CRM > Configurações.
//
// Só lê o banco local - nenhuma chamada ao CV -, então é barato e pode rodar de
// hora em hora sem peso nenhum.

import { verificarSilencio } from '../services/cv/cvWebhookHealthService.js';

export async function run() {
    const r = await verificarSilencio({ notificar: true });
    if (r.em_silencio || r.recuperados) {
        console.log(`[CV webhook saúde] ${r.em_silencio} em silêncio, ${r.avisos} aviso(s), ${r.recuperados} recuperado(s).`);
    }
    return r;
}

// Minuto 7 para não cair junto com os deltas (que rodam em :00/:20/:30) e
// bootstrap de 3 min: no boot o espelho ainda está subindo, e avisar antes
// disso seria avisar sobre um estado que nem acabou de carregar.
export default { run, cronPadrao: '7 * * * *', bootstrapDelayMs: 3 * 60 * 1000 };
