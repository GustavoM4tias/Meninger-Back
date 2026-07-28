// scheduler/reservaCvGapScheduler.js
//
// Preenche os BURACOS de idreserva que o delta sync não enxerga.
//
// Por que existe: o delta descobre reservas pela listagem do CV
// (/comercial/reservas/listar). Essa listagem não devolve tudo — reservas
// existem e respondem normalmente quando buscadas por id
// (/comercial/reservas/{id}), mas simplesmente não aparecem na listagem. O
// resultado é um banco com furos na sequência de idreserva, e reservas em
// etapa de assinatura que nunca chegam à projeção do Faturamento.
//
// O sweep id-a-id resolvia isso, mas varre a sequência inteira (milhares de
// ids × 5 chamadas cada) e por isso ficava desligado — nunca rodou em
// produção, já que ENABLE_CV_RESERVA_SWEEP_SCHEDULE não existia em env algum.
//
// Este job faz o mínimo necessário: pergunta ao banco QUAIS ids faltam e busca
// só esses, os mais recentes primeiro. Em regime normal são poucas dezenas por
// hora; ids que voltam 404 vão para cv_reserva_id_dead e não são tentados de
// novo, então o custo cai sozinho.

import cron from 'node-cron';
import db from '../models/sequelize/index.js';
import ReservaFullSweepService from '../services/bulkData/cv/ReservaFullSweepService.js';
import { markRunning, markFinished } from '../services/bulkData/cv/syncState.js';

const JOB = 'cv_reservas_gap';
const CRON_EXPR = process.env.RESERVA_CV_GAP_CRON_EXPRESSION || '25 * * * *';
const TZ = 'America/Sao_Paulo';

// Teto por execução: mantém o job curto e previsível. O que sobrar entra na
// próxima rodada, começando de novo pelos mais recentes.
const MAX_POR_RODADA = parseInt(process.env.RESERVA_CV_GAP_MAX || '150', 10);
// Quantos ids além do topo conhecido também são sondados, para pegar reservas
// novas que a listagem ainda não devolveu.
const MARGEM_TOPO = parseInt(process.env.RESERVA_CV_GAP_TAIL || '40', 10);

const service = new ReservaFullSweepService();
let rodando = false;

/** Ids ausentes na sequência, mais recentes primeiro, já sem os 404 conhecidos. */
export async function findMissingIds(limite = MAX_POR_RODADA) {
    const rows = await db.sequelize.query(`
        WITH topo AS (SELECT COALESCE(MAX(idreserva), 0) AS max_id FROM reservas),
        faixa AS (
            SELECT generate_series(1, (SELECT max_id FROM topo) + :margem) AS id
        )
        SELECT f.id
        FROM faixa f
        LEFT JOIN reservas r          ON r.idreserva = f.id
        LEFT JOIN cv_reserva_id_dead d ON d.idreserva = f.id
        WHERE r.idreserva IS NULL
          AND d.idreserva IS NULL
        ORDER BY f.id DESC
        LIMIT :limite
    `, {
        replacements: { margem: MARGEM_TOPO, limite },
        type: db.Sequelize.QueryTypes.SELECT,
    });
    return rows.map(r => Number(r.id)).filter(Number.isFinite);
}

export async function runGapFill() {
    if (rodando) {
        console.log('[CV Reservas GAP] já em execução, pulando tick');
        return null;
    }
    rodando = true;
    await markRunning(JOB);
    try {
        const ids = await findMissingIds();
        if (!ids.length) {
            console.log('[CV Reservas GAP] nenhum buraco na sequência');
            await markFinished(JOB, { status: 'ok', stats: { faltando: 0 } });
            return { faltando: 0 };
        }

        console.log(`[CV Reservas GAP] ${ids.length} id(s) ausente(s); buscando por id (${ids[ids.length - 1]}..${ids[0]})`);
        const stats = await service.run({ ids, skipDead: true });
        await markFinished(JOB, { status: 'ok', stats });
        console.log(`[CV Reservas GAP] concluído: ${JSON.stringify(stats)}`);
        return stats;
    } catch (e) {
        console.error('[CV Reservas GAP] erro:', e?.message || e);
        await markFinished(JOB, { status: 'error', message: e?.message || String(e) });
        return null;
    } finally {
        rodando = false;
    }
}

export default {
    start() {
        cron.schedule(CRON_EXPR, runGapFill, { timezone: TZ });
        console.log(`✅ CVCRM Reservas GAP agendado: ${CRON_EXPR} (${TZ})`);
    }
};
