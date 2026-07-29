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
            // Só cidades EM USO (alguém mora nela ou temos empreendimento lá).
            // O catálogo completo são os ~5.570 municípios do IBGE — usado no
            // cadastro de pessoas; num seletor de AUDIÊNCIA seria inútil.
            db.sequelize.query(
                `SELECT c.id, c.name, c.uf, c.active
                   FROM user_cities c
                  WHERE c.active = true
                    AND (
                      EXISTS (SELECT 1 FROM users u WHERE u.city_id = c.id)
                      OR EXISTS (
                        SELECT 1 FROM users u
                         WHERE u.city_id IS NULL
                           AND unaccent(upper(TRIM(u.city))) = unaccent(upper(TRIM(c.name))))
                      OR EXISTS (
                        SELECT 1 FROM enterprises e
                         WHERE e.active = true
                           AND unaccent(upper(TRIM(e.city))) = unaccent(upper(TRIM(c.name))))
                    )
                  ORDER BY c.name ASC`,
                { type: db.Sequelize.QueryTypes.SELECT }
            ),
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
