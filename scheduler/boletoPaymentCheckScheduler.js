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
import db from '../models/sequelize/index.js';
import { runDailyCheck } from '../services/boleto/BoletoPaymentCheckService.js';
import EcoLock from '../services/boleto/BoletoEcoLockService.js';
import { hojeYmd } from '../lib/atoParcelas.js';

// Tick de 10 em 10 min A PARTIR das 08h, nao so AS 08h: deploy/restart no meio
// da rodada (ou exatamente na hora) nao pode deixar o dia sem a conferencia de
// pagamento - e a rodada de parcelas das 09h depende dela. O dia fica marcado
// em boleto_settings.check_ultima_rodada_em (sobrevive a restart); no boot o
// scheduler chama o tick uma vez, sem esperar o proximo multiplo de 10.
const CRON_EXPR = '*/10 * * * *';
const HORA_RODADA = 8;
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const BOOT_DELAY_MS = 90 * 1000;
let rodando = false;

function horaBrasilia(now = new Date()) {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).format(now);
    return Number(h) % 24;
}

function isProductionEnv() {
    if (process.env.ENABLE_BOLETO_PAYMENT_CHECK_IN_DEV === 'true') return true;
    return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

async function runWithLock({ agendado = false } = {}) {
    if (!isProductionEnv()) {
        console.log('[BOLETO_CHECK_SCHED] Pulado — NODE_ENV != production e ENABLE_BOLETO_PAYMENT_CHECK_IN_DEV != true.');
        return;
    }
    if (rodando) { console.warn('[BOLETO_CHECK_SCHED] Rodada ja em andamento neste processo. Pulando.'); return; }
    rodando = true;
    try { return await executar({ agendado }); }
    finally { rodando = false; }
}

async function executar({ agendado }) {

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
    // So a rodada AGENDADA marca o dia: um "rodar agora" as 07h nao pode pular a das 08h.
    if (agendado && !r.result?.skipped) {
        await db.BoletoSettings.update({ check_ultima_rodada_em: new Date() }, { where: { id: 1 } }).catch(err => console.warn('[BOLETO_CHECK_SCHED] nao marcou o dia:', err.message));
    }
}

async function tick() {
    try {
        if (horaBrasilia() < HORA_RODADA) return;
        const s = await db.BoletoSettings.findByPk(1, { attributes: ['id', 'check_ultima_rodada_em'] });
        const ultima = s?.check_ultima_rodada_em ? hojeYmd(new Date(s.check_ultima_rodada_em)) : null;
        if (ultima === hojeYmd()) return;
        await runWithLock({ agendado: true });
    } catch (err) {
        console.error('[BOLETO_CHECK_SCHED] tick falhou:', err.message);
    }
}

const boletoPaymentCheckScheduler = {
    start() {
        cron.schedule(CRON_EXPR, tick, { timezone: TIMEZONE });
        // Retomada: subiu depois das 08h com o dia ainda nao marcado (deploy no
        // meio da rodada, ou exatamente na hora)? Roda ja, sem esperar o tick.
        setTimeout(() => tick().catch(() => {}), BOOT_DELAY_MS).unref?.();
        console.log(`✅ boletoPaymentCheckScheduler iniciado (tick ${CRON_EXPR} ${TIMEZONE}, roda a partir das ${HORA_RODADA}h; retoma no boot).`);
    },
    // Exposto pra ser chamável manualmente (botão admin ou rota /debug).
    runNow: runWithLock,
};

export default boletoPaymentCheckScheduler;
