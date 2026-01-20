import db from '../../models/sequelize/index.js';
import { Op } from 'sequelize';

const academyAdminMetaService = {
    async getMeta() {
        const [positions, departments, cities] = await Promise.all([
            db.Position.findAll({
                attributes: ['id', 'name', 'code', 'department_id'],
                where: { active: true },
                order: [['name', 'ASC']],
                raw: true,
            }),
            db.Department.findAll({
                attributes: ['id', 'name', 'code'],
                where: { active: true },
                order: [['name', 'ASC']],
                raw: true,
            }),
            db.UserCity.findAll({
                attributes: ['id', 'name', 'uf', 'active'],
                where: { active: true },
                order: [['name', 'ASC']],
                raw: true,
            }),
        ]);

        return { positions, departments, cities };
    },

    async searchUsers({ q = '' } = {}) {
        const term = String(q || '').trim();
        const where = term
            ? {
                [Op.or]: [
                    { username: { [Op.iLike]: `%${term}%` } },
                    { email: { [Op.iLike]: `%${term}%` } },
                    { position: { [Op.iLike]: `%${term}%` } },
                    { city: { [Op.iLike]: `%${term}%` } },
                ],
            }
            : {};

        const users = await db.User.findAll({
            where,
            attributes: ['id', 'username', 'email', 'role', 'position', 'city', 'status'],
            order: [['username', 'ASC']],
            limit: 50,
            raw: true,
        });

        return { results: users };
    },
};

export default academyAdminMetaService;
