// scheduler/boletoWindowScheduler.js
//
// Cron a cada 1 min. Retoma as emissões que ficaram agendadas por terem
// chegado fora da janela de funcionamento (padrão 06:00-23:00 de Brasília,
// configurável na tela do Boleto Caixa).
//
// Pega registros de boleto_history com `status='queued'`,
// `emissao_agendada_processada=false` e `emissao_agendada_para <= NOW()`, e
// re-executa o fluxo completo REAPROVEITANDO o mesmo registro (historyId) —
// uma linha por acionamento na tela, que sai de "Agendado" e vira o resultado
// real da emissão.
//
// Resiliente a restart: o estado vive no DB. Se o servidor cair entre o
// agendamento e a abertura da janela, o próximo boot continua de onde parou.
//
// Serialização: a emissão usa Playwright + lock do Ecobrança e leva dezenas de
// segundos. O guard `processando` impede que um tick novo entre enquanto o
// anterior ainda escoa a fila da manhã.

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import EventLogger from '../services/boleto/BoletoEventLogger.js';
import { processBoletoWebhook } from '../services/boleto/BoletoGenerationService.js';
import { formatarAgendamento } from '../lib/boletoJanela.js';

const { BoletoHistory } = db;
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const CRON_EXPR = '* * * * *'; // todo minuto
const LOTE_MAX = 10;           // por tick — o resto sai nos ticks seguintes

let processando = false;

async function retomarUm(item) {
    const tag = `[BOLETO_JANELA_SCHED][hist ${item.id}]`;

    // Marca ANTES de processar: se a emissão estourar, o registro não volta pra
    // fila num loop infinito — o erro fica visível no histórico pro admin.
    // UPDATE com WHERE processada=false age como CAS atômico.
    const [marcados] = await BoletoHistory.update(
        { emissao_agendada_processada: true },
        { where: { id: item.id, emissao_agendada_processada: false } }
    );
    if (!marcados) {
        console.log(`${tag} ⊘ Já retomado por outro ciclo — pulando.`);
        return;
    }

    await EventLogger.log({
        historyId: item.id, idreserva: item.idreserva,
        type: 'emission_window_released', severity: 'info',
        message: `Janela aberta - retomando emissão agendada para ${formatarAgendamento(item.emissao_agendada_para)}.`,
        data: { agendadoPara: item.emissao_agendada_para },
    });

    console.log(`${tag} ▶ Janela aberta — retomando emissão da reserva ${item.idreserva}.`);
    try {
        await processBoletoWebhook({
            idreserva: Number(item.idreserva),
            idtransacao: item.idtransacao || null,
            forcarAgora: true,   // já estamos dentro da janela; não re-agendar
            historyId: item.id,  // reaproveita o registro que estava 'queued'
        });
    } catch (err) {
        // processBoletoWebhook já trata os próprios erros e grava no histórico;
        // isto aqui cobre falha inesperada antes disso (ex.: CV fora do ar).
        console.error(`${tag} ✗ Falha retomando emissão: ${err.message}`);
        await BoletoHistory.update(
            { status: 'error', error_message: `Falha ao retomar emissão agendada: ${err.message}` },
            { where: { id: item.id, status: 'queued' } }
        ).catch(() => {});
    }
}

async function runTick() {
    if (processando) return; // fila anterior ainda escoando
    processando = true;
    try {
        const pendentes = await BoletoHistory.findAll({
            where: {
                status: 'queued',
                emissao_agendada_processada: false,
                emissao_agendada_para: { [Op.lte]: new Date() },
            },
            order: [['emissao_agendada_para', 'ASC'], ['id', 'ASC']],
            limit: LOTE_MAX,
        });
        if (!pendentes.length) return;

        console.log(`[BOLETO_JANELA_SCHED] ${pendentes.length} emissão(ões) agendada(s) pra retomar.`);
        // Sequencial de propósito: a emissão disputa o lock do Ecobrança e
        // rodar em paralelo só faria uma esperar a outra com timeout correndo.
        for (const item of pendentes) {
            await retomarUm(item);
        }
    } catch (err) {
        console.error('[BOLETO_JANELA_SCHED] tick falhou:', err.message);
    } finally {
        processando = false;
    }
}

const boletoWindowScheduler = {
    start() {
        cron.schedule(CRON_EXPR, runTick, { timezone: TIMEZONE });
        console.log(`✅ boletoWindowScheduler iniciado (${CRON_EXPR} ${TIMEZONE}).`);
    },
    runNow: runTick,
};

export default boletoWindowScheduler;
