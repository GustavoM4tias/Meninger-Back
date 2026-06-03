// services/boleto/BoletoEventLogger.js
//
// Helper enxuto pra registrar eventos no `boleto_events`. Centraliza a
// criação pra:
//   1) garantir que TODOS os eventos têm idreserva + boleto_history_id
//   2) capturar e logar erros de persistência sem quebrar o fluxo principal
//      (registrar evento é "best effort" — não deve derrubar emissão/check)
//   3) reaproveitar formatação de severidade/data
//
// Tipos canônicos estão documentados em models/sequelize/boleto/boletoEvent.js.

import db from '../../models/sequelize/index.js';

const { BoletoEvent } = db;

/**
 * Registra um evento. Se faltar history_id ou idreserva, loga warn e
 * tenta achar pelo outro campo pra recuperar contexto.
 *
 * @param {object} params
 * @param {number} params.historyId
 * @param {number} params.idreserva
 * @param {string} params.type
 * @param {string} [params.message]
 * @param {'info'|'warning'|'error'|'success'} [params.severity='info']
 * @param {object} [params.data]
 */
export async function log({ historyId, idreserva, type, message = null, severity = 'info', data = null }) {
    if (!type) {
        console.warn('[BoletoEventLogger] log() chamado sem type — ignorando.');
        return null;
    }
    if (!idreserva && historyId) {
        try {
            const row = await db.BoletoHistory.findByPk(historyId, { attributes: ['idreserva'] });
            if (row) idreserva = row.idreserva;
        } catch { /* noop */ }
    }
    if (!historyId || !idreserva) {
        console.warn(`[BoletoEventLogger] log(${type}) faltando ids (history=${historyId} reserva=${idreserva}) — pulando.`);
        return null;
    }
    try {
        return await BoletoEvent.create({
            boleto_history_id: historyId,
            idreserva,
            type,
            severity,
            message: message ? String(message).slice(0, 2000) : null,
            data: data ?? null,
        });
    } catch (err) {
        // Eventos são best-effort — falha aqui não pode quebrar o fluxo.
        console.warn(`[BoletoEventLogger] falha registrando "${type}" (history=${historyId}): ${err.message}`);
        return null;
    }
}

/**
 * Lista eventos de uma history em ordem cronológica crescente. Usado
 * pelo endpoint que alimenta o modal de timeline no frontend.
 */
export async function listByHistory(historyId, { limit = 200 } = {}) {
    if (!historyId) return [];
    return BoletoEvent.findAll({
        where: { boleto_history_id: historyId },
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        limit: Math.min(Math.max(1, Number(limit) || 200), 1000),
    });
}

export default { log, listByHistory };
