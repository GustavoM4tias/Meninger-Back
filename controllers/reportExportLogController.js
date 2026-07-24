// Trilha de auditoria das exportações de relatório.
//  • POST  /api/report-exports  → qualquer usuário autenticado registra a sua
//  • GET   /api/report-exports  → SOMENTE admin consulta
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';

const FORMATOS = ['pdf', 'html', 'excel', 'csv'];
const MAX_LIMIT = 200;

// Nunca confiamos no cliente para dizer QUEM exportou: a identidade vem do
// token (req.user). Do corpo só aceitamos o que descreve a exportação.
export const recordExport = async (req, res) => {
    try {
        const { report, format, periodStart, periodEnd, recordCount, filters } = req.body || {};

        const fmt = String(format || '').toLowerCase();
        if (!FORMATOS.includes(fmt)) {
            return responseHandler.error(res, 'Formato de exportação inválido.', 400);
        }

        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.ip || req.connection?.remoteAddress || null;

        const log = await db.ReportExportLog.create({
            userId: req.user?.id ?? null,
            userName: req.user?.username ?? null,
            userEmail: req.user?.email ?? null,
            report: String(report || 'leads').slice(0, 60),
            format: fmt,
            periodStart: periodStart || null,
            periodEnd: periodEnd || null,
            recordCount: Number.isFinite(Number(recordCount)) ? Number(recordCount) : null,
            filtersJson: filters && typeof filters === 'object' ? filters : null,
            ip: ip ? String(ip).slice(0, 64) : null,
            userAgent: req.headers['user-agent'] || null,
        });

        return res.status(201).json({ success: true, data: { id: log.id } });
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

export const listExports = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const where = {};

        if (req.query.report) where.report = String(req.query.report);
        if (req.query.format) where.format = String(req.query.format).toLowerCase();
        if (req.query.userId) where.userId = parseInt(req.query.userId, 10);

        // Busca livre por nome/e-mail de quem exportou
        if (req.query.q) {
            const q = `%${String(req.query.q).trim()}%`;
            where[Op.or] = [
                { userName: { [Op.iLike]: q } },
                { userEmail: { [Op.iLike]: q } },
            ];
        }

        // Janela por data da exportação
        const from = req.query.from, to = req.query.to;
        if (from || to) {
            where.createdAt = {};
            if (from) where.createdAt[Op.gte] = new Date(`${from}T00:00:00`);
            if (to) where.createdAt[Op.lte] = new Date(`${to}T23:59:59`);
        }

        const { rows, count } = await db.ReportExportLog.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit,
            offset: (page - 1) * limit,
        });

        return responseHandler.success(res, {
            results: rows,
            count,
            page,
            limit,
            pages: Math.ceil(count / limit),
        });
    } catch (error) {
        return responseHandler.error(res, error);
    }
};
