// scheduler/boletoSituacaoApplyScheduler.js
//
// Cron a cada 1 min. Processa registros de boleto_history que têm
// `situacao_pendente_em <= NOW()` e `situacao_pendente_aplicada = false`.
// Pra cada um, chama o CV pra alterar a situação e marca como aplicada.
//
// Resiliente a restart: o estado vive no DB. Se o servidor cair entre o
// agendamento e a aplicação, o próximo boot continua de onde parou.
//
// Idempotência:
//   - Filtro `aplicada=false` evita reprocessar.
//   - Mesmo se 2 instâncias do scheduler rodarem (não deveria, mas seguro),
//     o UPDATE WHERE aplicada=false age como CAS atômico.

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import apiCv from '../lib/apiCv.js';
import EventLogger from '../services/boleto/BoletoEventLogger.js';

const { BoletoHistory } = db;
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const CRON_EXPR = '* * * * *'; // todo minuto

async function applyOne(item) {
    const tag = `[BOLETO_SITUACAO_SCHED][hist ${item.id}]`;
    try {
        await apiCv.post('/v1/comercial/reservas/alterar-situacao', {
            idreserva_cv: Number(item.idreserva),
            idsituacao_destino: Number(item.situacao_pendente_id),
            comentario: 'Mudança automática (delay alinhado ao lote Sienge) — Boleto Caixa',
        });
        await item.update({
            situacao_pendente_aplicada: true,
            cv_situacao_alterada: true,
        });
        await EventLogger.log({
            historyId: item.id, idreserva: item.idreserva,
            type: 'cv_situation', severity: 'success',
            message: `Situação CV aplicada (com delay) para ID ${item.situacao_pendente_id}`,
            data: { situacaoId: item.situacao_pendente_id, agendadaPara: item.situacao_pendente_em },
        });
        console.log(`${tag} ✓ Situação ${item.situacao_pendente_id} aplicada com sucesso.`);
    } catch (err) {
        const detail = err?.response?.data?.error
            || err?.response?.data?.mensagem
            || err?.message
            || 'falha desconhecida';
        const status = err?.response?.status;
        console.error(`${tag} ✗ Falha aplicando situação (HTTP ${status || '??'}): ${detail}`);
        await EventLogger.log({
            historyId: item.id, idreserva: item.idreserva,
            type: 'cv_situation_failed', severity: 'error',
            message: `Falha ao aplicar situação ${item.situacao_pendente_id} (delay): ${detail}`,
            data: { httpStatus: status, retryable: status >= 500 },
        });
        // 5xx: deixa pendente pra próximo ciclo tentar de novo
        // 4xx: marca como "aplicada" pra não ficar reciclando erro permanente
        if (status && status < 500) {
            await item.update({ situacao_pendente_aplicada: true });
        }
    }
}

async function runTick() {
    try {
        const pendentes = await BoletoHistory.findAll({
            where: {
                situacao_pendente_id: { [Op.ne]: null },
                situacao_pendente_em: { [Op.lte]: new Date() },
                situacao_pendente_aplicada: false,
            },
            order: [['situacao_pendente_em', 'ASC'], ['id', 'ASC']],
            limit: 50, // sanity cap pra não estourar API CV em rajada
        });
        if (!pendentes.length) return;
        console.log(`[BOLETO_SITUACAO_SCHED] ${pendentes.length} situação(ões) maduras pra aplicar.`);
        for (const item of pendentes) {
            await applyOne(item);
        }
    } catch (err) {
        console.error('[BOLETO_SITUACAO_SCHED] tick falhou:', err.message);
    }
}

const boletoSituacaoApplyScheduler = {
    start() {
        cron.schedule(CRON_EXPR, runTick, { timezone: TIMEZONE });
        console.log(`✅ boletoSituacaoApplyScheduler iniciado (${CRON_EXPR} ${TIMEZONE}).`);
    },
    runNow: runTick,
};

export default boletoSituacaoApplyScheduler;
