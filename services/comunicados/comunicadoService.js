import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';

// Filtro de validade: comunicado PUBLISHED e dentro da janela start/end.
function activeWhere(now) {
    return {
        status: 'PUBLISHED',
        [Op.and]: [
            { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
            { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gte]: now } }] },
        ],
    };
}

const comunicadoService = {
    // Comunicados ATIVOS direcionados ao usuário (ele é destinatário), com o
    // estado de ciência. Ordena fixados/urgentes primeiro.
    async listForUser({ userId }) {
        if (!userId) return { results: [] };
        const now = new Date();

        const receipts = await db.ComunicadoReceipt.findAll({
            where: { userId: Number(userId) },
            attributes: ['comunicadoId', 'ackedAt'],
            raw: true,
        });
        if (!receipts.length) return { results: [] };
        const ackByCom = new Map(receipts.map((r) => [Number(r.comunicadoId), r.ackedAt]));

        const rows = await db.Comunicado.findAll({
            where: { id: { [Op.in]: Array.from(ackByCom.keys()) }, ...activeWhere(now) },
            order: [['pinned', 'DESC'], ['priority', 'ASC'], ['publishedAt', 'DESC']],
        });

        const results = rows.map((r) => {
            const ackedAt = ackByCom.get(Number(r.id));
            return {
                id: r.id,
                title: r.title,
                body: r.body,
                kind: r.kind,
                requiresAck: r.requiresAck,
                pinned: r.pinned,
                link: r.link,
                publishedAt: r.publishedAt,
                acked: !!ackedAt,
                ackedAt: ackedAt || null,
            };
        });
        return { results };
    },

    // Quantos comunicados OBRIGATÓRIOS ainda exigem ciência (badge no menu/sino).
    async pendingCount({ userId }) {
        if (!userId) return { pending: 0 };
        const now = new Date();
        const receipts = await db.ComunicadoReceipt.findAll({
            where: { userId: Number(userId), ackedAt: null },
            attributes: ['comunicadoId'],
            raw: true,
        });
        if (!receipts.length) return { pending: 0 };
        const ids = receipts.map((r) => Number(r.comunicadoId));
        const pending = await db.Comunicado.count({
            where: { id: { [Op.in]: ids }, requiresAck: true, ...activeWhere(now) },
        });
        return { pending };
    },

    // Confirma a ciência ("Li e estou ciente"). Idempotente.
    async ack({ id, userId, ip, userAgent }) {
        if (!userId) throw new Error('Não autenticado.');
        const receipt = await db.ComunicadoReceipt.findOne({
            where: { comunicadoId: Number(id), userId: Number(userId) },
        });
        if (!receipt) throw new Error('Você não é destinatário deste comunicado.');
        if (!receipt.ackedAt) {
            receipt.ackedAt = new Date();
            receipt.ackIp = (ip || '').slice(0, 64) || null;
            receipt.ackUserAgent = (userAgent || '').slice(0, 500) || null;
            await receipt.save();
        }
        return { ok: true, ackedAt: receipt.ackedAt };
    },
};

export default comunicadoService;
