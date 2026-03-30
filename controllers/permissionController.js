// /controllers/permissionController.js
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';

// Apenas usuários do Office (não Academy/CVCRM)
const OFFICE_PROVIDERS = ['INTERNAL', 'MICROSOFT'];

// ─── GET /api/permissions/me ─────────────────────────────────────────────────
// Retorna as permissões do usuário autenticado.
export async function getMyPermissions(req, res) {
    try {
        if (req.user.role === 'admin') {
            return res.json({ isAdmin: true, routes: null });
        }

        const perm = await db.UserPermission.findOne({ where: { userId: req.user.id } });
        return res.json({ isAdmin: false, routes: perm?.routes ?? [] });
    } catch (err) {
        console.error('[Permissions] getMyPermissions error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── GET /api/admin/permissions ──────────────────────────────────────────────
// Lista todos os usuários ativos com suas permissões atuais. (admin only)
export async function getAllPermissions(req, res) {
    try {
        const users = await db.User.findAll({
            where: {
                status: true,
                auth_provider: { [Op.in]: OFFICE_PROVIDERS },
            },
            attributes: ['id', 'username', 'email', 'role', 'status'],
            include: [{
                model: db.UserPermission,
                as: 'permission',
                required: false,
                attributes: ['routes', 'updatedAt'],
            }],
            order: [['username', 'ASC']],
        });

        return res.json(users);
    } catch (err) {
        console.error('[Permissions] getAllPermissions error:', err);
        return res.status(500).json({ message: err.message });
    }
}

// ─── PUT /api/admin/permissions/:userId ──────────────────────────────────────
// Substitui as permissões de um usuário específico. (admin only)
export async function setUserPermissions(req, res) {
    try {
        const { userId } = req.params;
        const { routes } = req.body;

        if (!Array.isArray(routes)) {
            return res.status(400).json({ message: '"routes" deve ser um array de strings.' });
        }

        const user = await db.User.findByPk(userId, { attributes: ['id', 'role', 'username'] });
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });

        if (user.role === 'admin') {
            return res.status(400).json({ message: 'Administradores têm acesso total por padrão. Não é possível editar suas permissões.' });
        }

        await db.UserPermission.upsert({ userId: parseInt(userId), routes });

        return res.json({ success: true, message: `Permissões de ${user.username} atualizadas.` });
    } catch (err) {
        console.error('[Permissions] setUserPermissions error:', err);
        return res.status(500).json({ message: err.message });
    }
}
