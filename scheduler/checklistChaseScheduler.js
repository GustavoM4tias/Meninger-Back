// scheduler/checklistChaseScheduler.js
// Motor de cobrança do Checklist. Tick de hora em hora; o serviço decide se roda
// com base nas settings (enabled + run_hour + fuso), então mudar a hora/fuso na
// tela admin tem efeito imediato sem reiniciar o servidor.
import cron from 'node-cron';
import cobrancaService from '../services/checklist/cobrancaService.js';

let job = null;

function start() {
    if (job) return;
    job = cron.schedule('5 * * * *', async () => {
        try {
            const settings = await cobrancaService.getSettings();
            if (!settings.cobranca_enabled) return;
            const hourNow = cobrancaService.hourInTz(settings.timezone || 'America/Sao_Paulo');
            if (hourNow !== Number(settings.run_hour)) return;
            const res = await cobrancaService.runEngine({});
            console.log(`[checklistChase] régua executada (${res.today}): ${res.fired} lembrete(s) de ${res.evaluated} avaliações.`);
        } catch (err) {
            console.warn('[checklistChase] erro:', err?.message || err);
        }
    });
    console.log('✅ checklistChaseScheduler iniciado (tick horário; dispara na hora configurada).');
}

export default { start };
