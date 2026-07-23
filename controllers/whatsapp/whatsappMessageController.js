// controllers/whatsapp/whatsappMessageController.js
//
// Listagem e estatísticas das mensagens enviadas/recebidas (admin).

import { Op, fn, col, literal } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { getRatesUSD, getUsdToBrl, estimateCostBRL } from '../../services/whatsapp/WhatsAppPricing.js';

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

        // Breakdown por categoria × cobrança (billable). Base do painel de gastos.
        const costRows = await WhatsappMessage.findAll({
            where: {
                direction: 'out',
                status: { [Op.in]: ['sent', 'delivered', 'read'] },
                created_at: { [Op.gte]: since },
            },
            attributes: [
                'cost_category',
                'billable',
                [fn('COUNT', col('id')), 'count'],
            ],
            group: ['cost_category', 'billable'],
            raw: true,
        });

        const byCostCategory = {}; // categoria → contagem total (compat. UI atual)
        const cost = {
            billableCount: 0,
            freeCount: 0,
            unknownCount: 0,          // categoria ainda não confirmada pelo webhook
            estimatedBRL: 0,
            byCategory: {},           // categoria → { count, billable, free, estBRL }
            freeWindowSavedBRL: 0,    // economia estimada das mensagens de serviço grátis
        };
        for (const r of costRows) {
            const cat = r.cost_category || 'desconhecido';
            const n = Number(r.count);
            byCostCategory[cat] = (byCostCategory[cat] || 0) + n;

            const slot = cost.byCategory[cat] || (cost.byCategory[cat] = { count: 0, billable: 0, free: 0, estBRL: 0 });
            slot.count += n;

            if (!r.cost_category) {
                cost.unknownCount += n;
            } else if (r.billable === false) {
                cost.freeCount += n;
                slot.free += n;
                // serviço grátis dentro da janela: quanto teria custado como template
                cost.freeWindowSavedBRL += n * estimateCostBRL({ cost_category: cat === 'service' ? 'utility' : cat, billable: true, status: 'sent' });
            } else {
                // billable=true OU billable ainda nulo mas com categoria cobrável
                const unit = estimateCostBRL({ cost_category: cat, billable: r.billable === false ? false : true, status: 'sent' });
                if (unit > 0) {
                    cost.billableCount += n;
                    slot.billable += n;
                    slot.estBRL += n * unit;
                    cost.estimatedBRL += n * unit;
                } else {
                    cost.freeCount += n;
                    slot.free += n;
                }
            }
        }
        cost.estimatedBRL = Math.round(cost.estimatedBRL * 100) / 100;
        cost.freeWindowSavedBRL = Math.round(cost.freeWindowSavedBRL * 100) / 100;

        return res.json({
            days,
            byStatus,
            byCostCategory,
            total: totals,
            deliveryRate,
            cost,
            rates: { usd: getRatesUSD(), usdToBrl: getUsdToBrl() },
        });
    } catch (err) {
        console.error('[whatsapp/messages/stats]', err);
        return res.status(500).json({ error: 'Falha ao calcular estatísticas.' });
    }
};
