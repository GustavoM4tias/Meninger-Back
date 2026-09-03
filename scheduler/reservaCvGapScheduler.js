// Este módulo expõe só o TRABALHO (`run`). Quem agenda, liga, desliga, mede o
// tempo e grava o resultado é o gerente (services/cv/cvCronManager.js), com a
// regra vindo de cv_sync_jobs e da tela CV CRM > Configurações.
//
// Separar as duas coisas foi o que permitiu a tela mostrar "quando rodou pela
// última vez e se deu certo" para TODOS os crons, e ter um "rodar agora" que é
// exatamente a mesma execução do agendamento - não um caminho paralelo, que
// poderia divergir do de verdade.
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

import db from '../models/sequelize/index.js';
import ReservaFullSweepService, { SQL_AINDA_ENTERRADO } from '../services/bulkData/cv/ReservaFullSweepService.js';
import { markRunning, markFinished } from '../services/bulkData/cv/syncState.js';

const JOB = 'cv_reservas_gap';
const CRON_EXPR = process.env.RESERVA_CV_GAP_CRON_EXPRESSION || '25 * * * *';

// Teto por execução: mantém o job curto e previsível. Referência de custo: o
// sweep faz ~130 ids em 37s. O que sobrar entra na próxima rodada.
const MAX_POR_RODADA = parseInt(process.env.RESERVA_CV_GAP_MAX || '300', 10);
// Quantos ids além do topo conhecido também são sondados, para pegar reservas
// novas que a listagem ainda não devolveu.
const MARGEM_TOPO = parseInt(process.env.RESERVA_CV_GAP_TAIL || '40', 10);

const service = new ReservaFullSweepService();
let rodando = false;

/**
 * Ids ausentes na sequência, sem os mortos definitivos (404). Os que deram 400
 * voltam para a fila quando a espera vence - o CV responde 400 para id que
 * ainda não nasceu, e um id enterrado de vez virava reserva perdida (ver
 * "Cemitério" no ReservaFullSweepService).
 *
 * A fatia é tirada das DUAS PONTAS: metade dos mais recentes (que é o que
 * interessa para a projeção) e metade dos mais antigos. Isso evita o cenário em
 * que um punhado de ids que falha sempre — nem vira reserva, nem vira 404 —
 * ocupa o topo da fila a cada rodada e impede que o resto seja alcançado.
 */
export async function findMissingIds(limite = MAX_POR_RODADA) {
    const metade = Math.max(1, Math.floor(limite / 2));
    const rows = await db.sequelize.query(`
        WITH topo AS (SELECT COALESCE(MAX(idreserva), 0) AS max_id FROM reservas),
        faixa AS (
            SELECT generate_series(1, (SELECT max_id FROM topo) + :margem) AS id
        ),
        buracos AS (
            SELECT f.id
            FROM faixa f
            LEFT JOIN reservas r           ON r.idreserva = f.id
            LEFT JOIN cv_reserva_id_dead d ON d.idreserva = f.id
            WHERE r.idreserva IS NULL
              AND (d.idreserva IS NULL OR NOT ${SQL_AINDA_ENTERRADO})
        )
        SELECT id FROM (
            (SELECT id FROM buracos ORDER BY id DESC LIMIT :metade)
            UNION
            (SELECT id FROM buracos ORDER BY id ASC  LIMIT :metade)
        ) x
        ORDER BY id DESC
    `, {
        replacements: { margem: MARGEM_TOPO, metade },
        type: db.Sequelize.QueryTypes.SELECT,
    });
    return rows.map(r => Number(r.id)).filter(Number.isFinite);
}

// Situações terminais: reserva parada aí não muda mais na prática.
// 3 Vendida · 4 Cancelada · 11 Vencida · 13 Distrato
const SITUACOES_TERMINAIS = [3, 4, 11, 13];
const MAX_ATIVAS_POR_RODADA = parseInt(process.env.RESERVA_CV_GAP_ATIVAS_MAX || '200', 10);

/**
 * Reservas EM ANDAMENTO que estão há mais tempo sem serem tocadas.
 *
 * O gap-fill acima cobre a reserva que nunca chegou. Falta o outro lado do
 * mesmo defeito: a reserva que já está no banco e sai da listagem do CV.
 * Como o delta só revisita o que a listagem devolve, ela congela no último
 * status conhecido — e são justamente as não-terminais (Em Assinatura, Envio
 * Sienge, Ato Emitido...) que alimentam a projeção.
 *
 * Revisitar por id é barato porque o conjunto é pequeno: as terminais, que são
 * a maioria esmagadora, ficam de fora.
 */
export async function findStaleActiveIds(limite = MAX_ATIVAS_POR_RODADA) {
    const rows = await db.sequelize.query(`
        SELECT r.idreserva AS id
        FROM reservas r
        WHERE COALESCE((r.situacao->>'idsituacao')::int, -1) NOT IN (:terminais)
        ORDER BY r.updated_at ASC NULLS FIRST
        LIMIT :limite
    `, {
        replacements: { terminais: SITUACOES_TERMINAIS, limite },
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
        const faltando = await findMissingIds();
        const desatualizadas = await findStaleActiveIds();

        // Um id pode estar nas duas listas? Não: uma está no banco, a outra não.
        // Ainda assim o Set protege contra buscar em duplicidade.
        const ids = [...new Set([...faltando, ...desatualizadas])];

        if (!ids.length) {
            console.log('[CV Reservas GAP] nada a fazer');
            await markFinished(JOB, { status: 'ok', stats: { faltando: 0, revisitadas: 0 } });
            return { faltando: 0, revisitadas: 0 };
        }

        console.log(
            `[CV Reservas GAP] ${faltando.length} ausente(s) + ` +
            `${desatualizadas.length} em andamento a revisitar = ${ids.length} id(s)`
        );
        const stats = await service.run({ ids, skipDead: true });
        await markFinished(JOB, { status: 'ok', stats });
        console.log(`[CV Reservas GAP] concluído: ${JSON.stringify(stats)}`);

        // Id que falha sem virar reserva nem 404 volta para a fila na próxima
        // rodada. Alguns são normais (timeout pontual), muitos e repetidos
        // indicam problema na API do CV — por isso ficam visíveis no log.
        if (stats?.failed) {
            console.warn(
                `⚠️  [CV Reservas GAP] ${stats.failed} id(s) falharam e seguem pendentes: ` +
                `${(stats.failed_ids || []).slice(0, 20).join(', ')}`
            );
        }
        return stats;
    } catch (e) {
        console.error('[CV Reservas GAP] erro:', e?.message || e);
        await markFinished(JOB, { status: 'error', message: e?.message || String(e) });
        return null;
    } finally {
        rodando = false;
    }
}

export async function run() {
    await runGapFill();
}

export default { run, cronPadrao: CRON_EXPR };
