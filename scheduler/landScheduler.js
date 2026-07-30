// scheduler/landScheduler.js
//
// Sincroniza o TERRENO (observação do título) a partir da API do Sienge.
// Roda de 5 em 5 minutos: a leitura por centro de custo custa ~19 requisições
// (~4s) para os 14 empreendimentos configurados, contra um teto de 200 req/min
// da API — cerca de 2% do orçamento, deixando folga para os demais syncs.
// Ajuste por LAND_CRON_EXPRESSION.
import cron from 'node-cron';
import LandDataController from '../controllers/external/landDataController.js';

const ctl = new LandDataController();
const CRON_EXPR = process.env.LAND_CRON_EXPRESSION || '*/5 * * * *';

let running = false;

export default {
  start() {
    cron.schedule(CRON_EXPR, async () => {
      // Guarda de reentrância: se uma rodada demorar mais que o intervalo, a
      // próxima espera em vez de duplicar chamadas à API.
      if (running) return;
      running = true;
      try {
        const fakeRes = { send: () => { }, status: () => ({ send: () => { } }) };
        await ctl.run({}, fakeRes);
      } catch (e) {
        console.error('[OBSTIT Sync] falhou:', e.message);
      } finally {
        running = false;
      }
    });

    console.log(`✅ OBSTIT Scheduler (terreno ao vivo) configurado: ${CRON_EXPR}`);
  }
};
