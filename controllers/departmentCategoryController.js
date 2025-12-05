// /api/controllers/departmentCategoryController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';

const { DepartmentCategory, Department } = db;

// GET /api/admin/department-categories?departmentId=...
export const listDepartmentCategories = async (req, res) => {
    try {
        const where = {};
        const { departmentId } = req.query;

        if (departmentId) {
            where.department_id = departmentId;
        }

        const categories = await DepartmentCategory.findAll({
            where,
            include: [
                {
                    model: Department,
                    as: 'department',
                    attributes: ['id', 'name', 'code', 'active'],
                },
            ],
            order: [['name', 'ASC']],
        });

        return responseHandler.success(res, categories);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// POST /api/admin/department-categories
export const createDepartmentCategory = async (req, res) => {
    const { name, code, description, departmentId } = req.body;

    if (!name || !code || !departmentId) {
        return responseHandler.error(res, 'Nome, código e departamento são obrigatórios');
    }

    try {
        const exists = await DepartmentCategory.findOne({ where: { code } });
        if (exists) {
            return responseHandler.error(res, 'Código já cadastrado');
        }

        const category = await DepartmentCategory.create({
            name,
            code,
            description: description || null,
            department_id: departmentId,
            active: true,
        });

        return responseHandler.success(res, category);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// PUT /api/admin/department-categories/:id
export const updateDepartmentCategory = async (req, res) => {
    const { id } = req.params;
    const { name, code, description, departmentId, active } = req.body;

    try {
        const category = await DepartmentCategory.findByPk(id);
        if (!category) {
            return responseHandler.error(res, 'Categoria não encontrada', 404);
        }

        if (code && code !== category.code) {
            const exists = await DepartmentCategory.findOne({ where: { code } });
            if (exists) {
                return responseHandler.error(res, 'Código já cadastrado');
            }
        }

        if (departmentId) category.department_id = departmentId;
        if (name !== undefined) category.name = name;
        if (code !== undefined) category.code = code;
        if (description !== undefined) category.description = description;
        if (active !== undefined) category.active = active;

        await category.save();
        return responseHandler.success(res, category);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// DELETE /api/admin/department-categories/:id (soft delete)
export const deleteDepartmentCategory = async (req, res) => {
    const { id } = req.params;

    try {
        const category = await DepartmentCategory.findByPk(id);
        if (!category) {
            return responseHandler.error(res, 'Categoria não encontrada', 404);
        }

        category.active = false;
        await category.save();

        return responseHandler.success(res, { message: 'Categoria desativada com sucesso' });
    } catch (error) {
        return responseHandler.error(res, error);
    }
};
