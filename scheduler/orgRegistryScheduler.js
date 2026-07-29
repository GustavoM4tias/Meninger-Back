// scheduler/orgRegistryScheduler.js
//
// Sync diário do registro unificado de empresas/empreendimentos (CV + Sienge),
// de madrugada — dispensa o sync manual na tela Sincronização de empresas
// (que continua existindo para rodadas sob demanda).

import cron from 'node-cron';
import { syncAll } from '../services/org/enterpriseRegistryService.js';

const CRON = process.env.ORG_REGISTRY_CRON_EXPRESSION || '0 3 * * *'; // 03:00 BRT diário
const TZ = 'America/Sao_Paulo';

export default {
    start() {
        cron.schedule(CRON, async () => {
            console.log(`[orgRegistry] Sync diário iniciando (${new Date().toISOString()})`);
            try {
                await syncAll();
            } catch (e) {
                console.error('[orgRegistry] sync diário falhou:', e?.message || e);
            }
        }, { timezone: TZ });

        console.log(`✅ Sync de empresas/empreendimentos agendado: ${CRON} (${TZ})`);
    }
};
