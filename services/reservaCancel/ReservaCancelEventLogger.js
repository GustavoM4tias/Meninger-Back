// services/reservaCancel/ReservaCancelEventLogger.js
//
// Helper enxuto pra registrar eventos no `reserva_cancel_events` (mesmo
// desenho do BoletoEventLogger): best-effort — falha ao persistir evento
// não pode derrubar o fluxo principal.

import db from '../../models/sequelize/index.js';

export async function log({ historyId, idreserva, type, message = null, severity = 'info', data = null }) {
    if (!type || !historyId || !idreserva) {
        console.warn(`[ReservaCancelEventLogger] log(${type}) faltando ids (history=${historyId} reserva=${idreserva}) — pulando.`);
        return null;
    }
    try {
        return await db.ReservaCancelEvent.create({
            history_id: historyId,
            idreserva,
            type,
            severity,
            message: message ? String(message).slice(0, 2000) : null,
            data: data ?? null,
        });
    } catch (err) {
        console.warn(`[ReservaCancelEventLogger] falha registrando "${type}" (history=${historyId}): ${err.message}`);
        return null;
    }
}

export async function listByHistory(historyId, { limit = 200 } = {}) {
    if (!historyId) return [];
    return db.ReservaCancelEvent.findAll({
        where: { history_id: historyId },
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        limit: Math.min(Math.max(1, Number(limit) || 200), 1000),
    });
}

export async function listByReserva(idreserva, { limit = 2000 } = {}) {
    if (!idreserva) return [];
    return db.ReservaCancelEvent.findAll({
        where: { idreserva },
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        limit: Math.min(Math.max(1, Number(limit) || 2000), 5000),
    });
}

export default { log, listByHistory, listByReserva };
