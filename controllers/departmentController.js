import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';

const { Department, Position } = db;

// GET /api/admin/departments
export const listDepartments = async (req, res) => {
    try {
        const departments = await Department.findAll({
            order: [['name', 'ASC']],
        });
        return responseHandler.success(res, departments);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// POST /api/admin/departments
export const createDepartment = async (req, res) => {
    const { name, code, description } = req.body;

    if (!name || !code) {
        return responseHandler.error(res, 'Nome e código do departamento são obrigatórios');
    }

    try {
        const exists = await Department.findOne({ where: { code } });
        if (exists) {
            return responseHandler.error(res, 'Código de departamento já cadastrado');
        }

        const dep = await Department.create({
            name,
            code,
            description: description || null,
            active: true,
        });

        return responseHandler.success(res, dep);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// PUT /api/admin/departments/:id
export const updateDepartment = async (req, res) => {
    const { id } = req.params;
    const { name, code, description, active } = req.body;

    try {
        const dep = await Department.findByPk(id);
        if (!dep) {
            return responseHandler.error(res, 'Departamento não encontrado', 404);
        }

        if (code && code !== dep.code) {
            const exists = await Department.findOne({ where: { code } });
            if (exists) {
                return responseHandler.error(res, 'Código de departamento já cadastrado');
            }
        }

        dep.name = name ?? dep.name;
        dep.code = code ?? dep.code;
        dep.description = description ?? dep.description;
        if (active !== undefined) dep.active = active;

        await dep.save();
        return responseHandler.success(res, dep);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// DELETE /api/admin/departments/:id  (soft delete)
export const deleteDepartment = async (req, res) => {
    const { id } = req.params;

    try {
        const dep = await Department.findByPk(id);
        if (!dep) {
            return responseHandler.error(res, 'Departamento não encontrado', 404);
        }

        // Opcional: valida se tem cargos ativos ainda usando esse departamento
        const linkedPositions = await Position.count({
            where: { department_id: id, active: true },
        });

        if (linkedPositions > 0) {
            return responseHandler.error(
                res,
                'Não é possível desativar um departamento com cargos ativos vinculados'
            );
        }

        dep.active = false;
        await dep.save();

        return responseHandler.success(res, { message: 'Departamento desativado com sucesso' });
    } catch (error) {
        return responseHandler.error(res, error);
    }
};
