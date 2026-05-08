// controllers/whatsapp/whatsappMessageController.js
//
// Listagem e estatísticas das mensagens enviadas/recebidas (admin).

import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';

const { WhatsappMessage, User } = db;

/**
 * GET /api/whatsapp/messages
 * Filtros: status, direction, q (telefone ou wamid), userId, limit, offset
 */
export const listMessages = async (req, res) => {
    try {
        const { status, direction, q, userId } = req.query;
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Math.max(Number(req.query.offset) || 0, 0);

        const where = {};
        if (status) where.status = status;
        if (direction) where.direction = direction;
        if (userId) where.user_id = Number(userId);
        if (q) {
            where[Op.or] = [
                { to_phone: { [Op.iLike]: `%${q}%` } },
                { from_phone: { [Op.iLike]: `%${q}%` } },
                { meta_message_id: { [Op.iLike]: `%${q}%` } },
                { template_name: { [Op.iLike]: `%${q}%` } },
            ];
        }

        const { rows, count } = await WhatsappMessage.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit, offset,
            include: [{ model: User, as: 'user', attributes: ['id', 'username', 'email'] }],
        });

        return res.json({
            items: rows.map(r => r.get({ plain: true })),
            total: count,
        });
    } catch (err) {
        console.error('[whatsapp/messages/list]', err);
        return res.status(500).json({ error: 'Falha ao listar mensagens.' });
    }
};

/**
 * GET /api/whatsapp/messages/stats?days=30
 */
export const stats = async (req, res) => {
    try {
        const days = Math.min(Number(req.query.days) || 30, 180);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const rows = await WhatsappMessage.findAll({
            where: { direction: 'out', created_at: { [Op.gte]: since } },
            attributes: [
                'status',
                [fn('COUNT', col('id')), 'count'],
            ],
            group: ['status'],
            raw: true,
        });

        const byStatus = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, dry_run: 0 };
        rows.forEach(r => { byStatus[r.status] = Number(r.count); });

        const totals = Object.values(byStatus).reduce((a, b) => a + b, 0);
        const deliveredOrRead = byStatus.delivered + byStatus.read;
        const deliveryRate = totals ? deliveredOrRead / totals : 0;

        const costRows = await WhatsappMessage.findAll({
            where: {
                direction: 'out',
                created_at: { [Op.gte]: since },
                cost_category: { [Op.ne]: null },
            },
            attributes: ['cost_category', [fn('COUNT', col('id')), 'count']],
            group: ['cost_category'],
            raw: true,
        });
        const byCostCategory = {};
        costRows.forEach(r => { byCostCategory[r.cost_category] = Number(r.count); });

        return res.json({
            days,
            byStatus,
            byCostCategory,
            total: totals,
            deliveryRate,
        });
    } catch (err) {
        console.error('[whatsapp/messages/stats]', err);
        return res.status(500).json({ error: 'Falha ao calcular estatísticas.' });
    }
};
