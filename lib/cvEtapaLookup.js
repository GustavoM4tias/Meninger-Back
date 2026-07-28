// lib/cvEtapaLookup.js
//
// Etapa CV (reserva + repasse) para listagens de histórico.
//
// A etapa ATUAL da reserva e do repasse é lida da tabela local `reservas`
// (sincronizada de hora em hora) - nenhuma chamada à API do CV por linha. As
// cores (cor_bg/cor_nome) vêm dos workflows do CV, que já têm cache de 1h nos
// respectivos serviços; se a busca de cores falhar, a listagem segue sem cor
// (best-effort).
//
// Nasceu dentro do módulo Boleto Caixa e foi extraído aqui quando o módulo
// Cancelamento de Reservas passou a mostrar a mesma informação.

import db from '../models/sequelize/index.js';
import { getReservaWorkflow } from '../controllers/cv/reservas.js';
import { getRepasseWorkflow } from '../services/cv/repasseWorkflowService.js';

export function csvInts(v) {
    return String(v || '')
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n > 0);
}

export async function getCvWorkflowColorMaps() {
    const maps = { reserva: new Map(), repasse: new Map() };
    try {
        const wf = await getReservaWorkflow();
        for (const s of wf?.situacoes || []) {
            maps.reserva.set(Number(s.idsituacao), { cor_bg: s.cor_bg || null, cor_nome: s.cor_nome || null });
        }
    } catch (err) {
        console.warn('[CV-ETAPA] Workflow de reservas indisponível (segue sem cor):', err.message);
    }
    try {
        const wf = await getRepasseWorkflow();
        for (const s of wf?.situacoes || []) {
            maps.repasse.set(Number(s.idsituacao), { cor_bg: s.cor_bg || null, cor_nome: s.cor_nome || null });
        }
    } catch (err) {
        console.warn('[CV-ETAPA] Workflow de repasses indisponível (segue sem cor):', err.message);
    }
    return maps;
}

/** Mapa idreserva → { cv_situacao*, cv_situacao_repasse*, cv_idrepasse }. */
export async function fetchCvEtapaByReserva(idreservas) {
    const out = new Map();
    const ids = [...new Set((idreservas || []).map(Number).filter(Number.isFinite))];
    if (!ids.length) return out;
    const rows = await db.sequelize.query(`
        SELECT r.idreserva,
               (r.situacao->>'idsituacao')::int AS cv_idsituacao,
               r.situacao->>'situacao'          AS cv_situacao,
               r.idsituacao_repasse             AS cv_idsituacao_repasse,
               r.status_repasse                 AS cv_situacao_repasse,
               rp.idrepasse                     AS cv_idrepasse
          FROM reservas r
          LEFT JOIN LATERAL (
            SELECT MAX(idrepasse) AS idrepasse FROM repasses WHERE idreserva = r.idreserva
          ) rp ON TRUE
         WHERE r.idreserva IN (:ids)`,
        { replacements: { ids }, type: db.Sequelize.QueryTypes.SELECT });
    const maps = await getCvWorkflowColorMaps();
    for (const r of rows) {
        const corR = maps.reserva.get(Number(r.cv_idsituacao)) || {};
        const corP = maps.repasse.get(Number(r.cv_idsituacao_repasse)) || {};
        out.set(Number(r.idreserva), {
            cv_idsituacao: r.cv_idsituacao,
            cv_situacao: r.cv_situacao,
            cv_situacao_cor_bg: corR.cor_bg || null,
            cv_situacao_cor_nome: corR.cor_nome || null,
            cv_idsituacao_repasse: r.cv_idsituacao_repasse,
            cv_situacao_repasse: r.cv_situacao_repasse,
            cv_repasse_cor_bg: corP.cor_bg || null,
            cv_repasse_cor_nome: corP.cor_nome || null,
            cv_idrepasse: r.cv_idrepasse,
        });
    }
    return out;
}

/**
 * Resolve o filtro por etapa CV (cvSituacao/cvRepasse, CSV de ids) em uma
 * lista de idreservas que casam. Retorna null quando o filtro não foi usado.
 */
export async function resolveCvEtapaFilter({ cvSituacao, cvRepasse }) {
    const sit = csvInts(cvSituacao);
    const rep = csvInts(cvRepasse);
    if (!sit.length && !rep.length) return null;
    const conds = [];
    const repl = {};
    if (sit.length) { conds.push(`(situacao->>'idsituacao')::int IN (:sit)`); repl.sit = sit; }
    if (rep.length) { conds.push(`idsituacao_repasse IN (:rep)`); repl.rep = rep; }
    const rows = await db.sequelize.query(
        `SELECT idreserva FROM reservas WHERE ${conds.join(' AND ')}`,
        { replacements: repl, type: db.Sequelize.QueryTypes.SELECT },
    );
    return rows.map(r => Number(r.idreserva));
}

/**
 * Aplica o filtro de etapa CV no `where` do histórico: restringe idreserva à
 * interseção com as reservas que casam no CV. `[-1]` força resultado vazio
 * quando nada casa (Op.in com array vazio vira `IN (NULL)`).
 */
export function applyCvIdsToWhere(where, cvIds, Op) {
    if (!cvIds) return;
    if (typeof where.idreserva === 'number') {
        where.idreserva = cvIds.includes(where.idreserva) ? where.idreserva : -1;
    } else {
        where.idreserva = { [Op.in]: cvIds.length ? cvIds : [-1] };
    }
}

/**
 * Etapas CV presentes entre as reservas de uma tabela de histórico - alimenta
 * os filtros "Etapa (reserva)" e "Etapa (repasse)", já com as cores do
 * workflow do CV pro front pintar no padrão de lá.
 *
 * @param {string} tabela nome da tabela de histórico (com coluna idreserva).
 */
export async function fetchCvEtapaFacets(tabela) {
    const [cvSituacoes] = await db.sequelize.query(`
        SELECT (r.situacao->>'idsituacao')::int AS id,
               r.situacao->>'situacao'          AS nome,
               COUNT(DISTINCT h.idreserva)::int AS qty
          FROM ${tabela} h
          JOIN reservas r ON r.idreserva = h.idreserva
         WHERE r.situacao->>'idsituacao' IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 2
    `);
    const [cvRepasses] = await db.sequelize.query(`
        SELECT r.idsituacao_repasse             AS id,
               r.status_repasse                 AS nome,
               COUNT(DISTINCT h.idreserva)::int AS qty
          FROM ${tabela} h
          JOIN reservas r ON r.idreserva = h.idreserva
         WHERE r.idsituacao_repasse IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 2
    `);
    const maps = await getCvWorkflowColorMaps();
    const withColor = (list, map) => list.map(i => ({ ...i, ...(map.get(Number(i.id)) || {}) }));
    return {
        cvSituacoes: withColor(cvSituacoes, maps.reserva),
        cvRepasses: withColor(cvRepasses, maps.repasse),
    };
}
