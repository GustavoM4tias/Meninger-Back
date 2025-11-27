// api/controllers/userCityController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';

const { UserCity } = db;

// GET /api/admin/user-cities
export const listUserCities = async (req, res) => {
    try {
        const cities = await UserCity.findAll({
            order: [['name', 'ASC']],
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
