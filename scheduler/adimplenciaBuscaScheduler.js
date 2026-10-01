// scheduler/adimplenciaBuscaScheduler.js
// A cada minuto procura, nas caixas das buscas abertas, o e-mail com a
// exportação de unidades do CV e aplica a adimplência premiada. Sem busca
// aberta é uma consulta e mais nada. Ver services/cv/adimplenciaBuscaService.js.
import cron from 'node-cron';
import { processarPendentes } from '../services/cv/adimplenciaBuscaService.js';

const CRON_EXPR = process.env.CV_ADIMPLENCIA_BUSCA_CRON || '* * * * *';

export default {
    start() {
        cron.schedule(CRON_EXPR, () => {
            processarPendentes().catch((err) => console.error('[AdimplenciaCV] tick falhou:', err?.message || err));
        });
        console.log(`✅ Busca de adimplência no CV configurada: ${CRON_EXPR}`);
    },
};
