// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js).
import PriceTableSyncService from '../services/bulkData/cv/PriceTableSyncService.js';
import RealtorSyncService from '../services/bulkData/cv/RealtorSyncService.js';
import CorrespondentSyncService from '../services/bulkData/cv/CorrespondentSyncService.js';

// Padrão: uma vez por dia às 6h (tabelas de preço mudam pouco)
// Pode ser sobrescrito com CV_EXTRAS_CRON_EXPRESSION
const CRON = process.env.CV_EXTRAS_CRON_EXPRESSION || '0 6 * * *';

// Os tres cadastros sao independentes: um que falhe nao pode impedir os
// outros de atualizar. Por isso cada um tem o proprio try, e o run() so
// propaga erro se TODOS falharem - senao a tela marcaria como falha uma
// rodada que atualizou duas de tres coisas.
export async function run() {
    const falhas = [];

    try {
        await new PriceTableSyncService().syncAll();
    } catch (e) {
        falhas.push('tabelas de preço: ' + (e?.message || e));
        console.error('[CV Extras] Erro PriceTable sync:', e?.message || e);
    }

    try {
        await new RealtorSyncService().syncAll();
    } catch (e) {
        falhas.push('corretores: ' + (e?.message || e));
        console.error('[CV Extras] Erro Realtor sync:', e?.message || e);
    }

    try {
        await new CorrespondentSyncService().syncAll();
    } catch (e) {
        falhas.push('correspondentes: ' + (e?.message || e));
        console.error('[CV Extras] Erro Correspondent sync:', e?.message || e);
    }

    if (falhas.length === 3) throw new Error(falhas.join(' | '));
    if (falhas.length) return { parcial: true, falhas };
    return null;
}

export default { run, cronPadrao: CRON };
