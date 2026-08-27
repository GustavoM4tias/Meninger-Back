// scheduler/envioSiengeWatchScheduler.js
//
// Roda de 15 em 15 minutos (padrão configurável): o lote do CV é de 5 em 5, e a
// ideia é justamente pegar o erro na hora, enquanto quem vendeu ainda lembra do
// caso. Cada reserva gera um aviso só - ver `avisados_ids` no service.
//
// A frequência e o liga/desliga moram em envio_sienge_watch_settings: a tela
// manda, não o código.
import cron from 'node-cron';
import { runWatch, getSettings } from '../services/sienge/envioSiengeWatchService.js';

const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const CRON_PADRAO = '*/15 * * * *';

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
