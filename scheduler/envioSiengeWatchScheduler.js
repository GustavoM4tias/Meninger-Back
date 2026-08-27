// scheduler/envioSiengeWatchScheduler.js
//
// Uma rodada por dia basta: a fila do CV para o Sienge tem mediana de 20h e
// vazão de 5 a 13 por dia, então nada muda de minuto em minuto. Roda às 09:30
// (padrão configurável) para o aviso chegar com o dia começando, e depois do
// sync de reservas das 09:00.
//
// O horário e o liga/desliga moram em envio_sienge_watch_settings - a tela manda,
// não o código.
import cron from 'node-cron';
import { runWatch, getSettings } from '../services/sienge/envioSiengeWatchService.js';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const CRON_PADRAO = '30 9 * * *';

let task = null;
let rodando = false;

async function tick() {
    if (rodando) return;
    rodando = true;
    try {
        const settings = await getSettings();
        if (!settings.active) return;
        await runWatch();
    } catch (err) {
        console.error('[ENVIO_SIENGE_WATCH] rodada falhou:', err.message);
    } finally {
        rodando = false;
    }
}

const envioSiengeWatchScheduler = {
    async start() {
        let expr = CRON_PADRAO;
        try {
            const s = await getSettings();
            if (s.cron_expression && cron.validate(s.cron_expression)) expr = s.cron_expression;
        } catch { /* usa o padrão */ }
        if (task) task.stop();
        task = cron.schedule(expr, tick, { timezone: TIMEZONE });
        console.log(`✅ envioSiengeWatchScheduler iniciado (${expr} ${TIMEZONE}).`);
    },
    stop() { if (task) task.stop(); },
    runNow: () => runWatch(),
};

export default envioSiengeWatchScheduler;
