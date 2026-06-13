// scheduler/boletoPaymentCheckScheduler.js
//
// Cron diário às 08:00 horário de Brasília. Roda BoletoPaymentCheckService
// pra todos os boletos pendentes — detecta pagamentos e faz baixa por
// devolução de boletos vencidos.
//
// SEGURANÇA:
//   1. Mutex via DB pra serializar acesso ao Ecobrança (concorrência com
//      emissão via webhook do CV). Se outro processo está usando, pula.
//   2. Idempotente: boleto já com payment_status != 'pending' é ignorado.
//   3. Em ambiente local (NODE_ENV != 'production'), NÃO roda — evita que
//      dev consulte/baixe boletos em produção sem querer.
//
// Override em dev: ENABLE_BOLETO_PAYMENT_CHECK_IN_DEV=true no .env.

import cron from 'node-cron';
import { runDailyCheck } from '../services/boleto/BoletoPaymentCheckService.js';
import EcoLock from '../services/boleto/BoletoEcoLockService.js';

const CRON_EXPR = '0 8 * * *';
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

function isProductionEnv() {
    if (process.env.ENABLE_BOLETO_PAYMENT_CHECK_IN_DEV === 'true') return true;
    return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

async function runWithLock() {
    if (!isProductionEnv()) {
        console.log('[BOLETO_CHECK_SCHED] Pulado — NODE_ENV != production e ENABLE_BOLETO_PAYMENT_CHECK_IN_DEV != true.');
        return;
    }

    const owner = `check:scheduler:${new Date().toISOString()}`;
    // TTL 2h — suporta rodada com várias centenas de boletos (~20s por boleto +
    // login/selectCompany por empresa). Como o cron só roda 1x/dia, mesmo que
    // o lock fique pendurado por engano, ninguém vai conflitar com ele.
    const r = await EcoLock.withLock(owner, async () => {
        return runDailyCheck();
    }, 120);

    if (!r.acquired) {
        console.warn('[BOLETO_CHECK_SCHED] Lock Ecobrança ocupado — outra operação em andamento. Pulando rodada.');
        return;
    }
    if (r.error) {
        console.error('[BOLETO_CHECK_SCHED] Rodada falhou:', r.error.message);
        return;
    }
    console.log('[BOLETO_CHECK_SCHED] Rodada concluída com sucesso.');
}

const boletoPaymentCheckScheduler = {
    start() {
        cron.schedule(CRON_EXPR, runWithLock, { timezone: TIMEZONE });
        console.log(`✅ boletoPaymentCheckScheduler iniciado (${CRON_EXPR} ${TIMEZONE}).`);
    },
    // Exposto pra ser chamável manualmente (botão admin ou rota /debug).
    runNow: runWithLock,
};

export default boletoPaymentCheckScheduler;
