// api/controllers/userCityController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';

const { UserCity } = db;

// GET /api/admin/user-cities[?inUse=true][&q=texto][&limit=n]
//
// O catálogo é o conjunto de municípios do IBGE (~5.570) — completo de
// propósito, para o cadastro de pessoas aceitar qualquer cidade.
//
//   inUse=true → só as cidades EM USO (alguém mora nela ou temos
//                empreendimento lá). É o que faz sentido em seletor de
//                AUDIÊNCIA (Mural/Academy) e em filtros: a lista inteira
//                do Brasil ali seria inútil.
//   q          → busca por nome (para autocomplete sem baixar tudo).
export const listUserCities = async (req, res) => {
    try {
        const inUse = String(req.query.inUse || '') === 'true';
        const q = String(req.query.q || '').trim();
        const limit = Math.min(Number(req.query.limit) || 0, 6000) || undefined;

        if (inUse) {
            const rows = await db.sequelize.query(
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
            );
            return responseHandler.success(res, rows);
        }

        const where = {};
        if (q) where.name = { [db.Sequelize.Op.iLike]: `%${q}%` };

        const cities = await UserCity.findAll({
            where,
            order: [['name', 'ASC']],
            ...(limit ? { limit } : {}),
        });
        return responseHandler.success(res, cities);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// POST /api/admin/user-cities
export const createUserCity = async (req, res) => {
    const { name, uf } = req.body;

    if (!name) {
        return responseHandler.error(res, 'Nome da cidade é obrigatório');
    }

    try {
        const exists = await UserCity.findOne({ where: { name } });
        if (exists) {
            return responseHandler.error(res, 'Cidade já cadastrada');
        }

        const city = await UserCity.create({
            name,
            uf: uf || null,
            active: true,
        });

        return responseHandler.success(res, city);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// PUT /api/admin/user-cities/:id
export const updateUserCity = async (req, res) => {
    const { id } = req.params;
    const { name, uf, active } = req.body;

    try {
        const city = await UserCity.findByPk(id);
        if (!city) {
            return responseHandler.error(res, 'Cidade não encontrada', 404);
        }

        if (name && name !== city.name) {
            const exists = await UserCity.findOne({ where: { name } });
            if (exists) {
                return responseHandler.error(res, 'Cidade já cadastrada');
            }
        }

        city.name = name ?? city.name;
        city.uf = uf ?? city.uf;
        if (active !== undefined) city.active = active;

        await city.save();
        return responseHandler.success(res, city);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// DELETE /api/admin/user-cities/:id (soft delete)
export const deleteUserCity = async (req, res) => {
    const { id } = req.params;

    try {
        const city = await UserCity.findByPk(id);
        if (!city) {
            return responseHandler.error(res, 'Cidade não encontrada', 404);
        }

        city.active = false;
        await city.save();

        return responseHandler.success(res, { message: 'Cidade desativada com sucesso' });
    } catch (error) {
        return responseHandler.error(res, error);
    }
};
