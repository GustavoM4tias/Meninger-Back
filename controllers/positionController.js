// api/controllers/positionController.js
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';

const { Position } = db;

// GET /api/admin/positions
// GET /api/admin/positions
export const listPositions = async (req, res) => {
    try {
        const positions = await Position.findAll({
            order: [['name', 'ASC']],
            include: [{
                model: db.Department,
                as: 'department',
                attributes: ['id', 'name', 'code'],
            }],
        });
        return responseHandler.success(res, positions);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// POST /api/admin/positions
export const createPosition = async (req, res) => {
    const { name, code, description, is_internal, is_partner, departmentId } = req.body;

    if (!name || !code) {
        return responseHandler.error(res, 'Nome e código são obrigatórios');
    }
    if (!departmentId) {
        return responseHandler.error(res, 'Departamento é obrigatório');
    }

    try {
        const exists = await Position.findOne({ where: { code } });
        if (exists) {
            return responseHandler.error(res, 'Código já cadastrado');
        }

        // valida se departamento existe
        const department = await db.Department.findByPk(departmentId);
        if (!department) {
            return responseHandler.error(res, 'Departamento inválido');
        }

        const position = await Position.create({
            name,
            code,
            description: description || null,
            is_internal: is_internal ?? true,
            is_partner: is_partner ?? false,
            active: true,
            department_id: departmentId,
        });

        return responseHandler.success(res, position);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// PUT /api/admin/positions/:id
export const updatePosition = async (req, res) => {
    const { id } = req.params;
    const { name, code, description, is_internal, is_partner, active, departmentId } = req.body;

    try {
        const position = await Position.findByPk(id);
        if (!position) {
            return responseHandler.error(res, 'Cargo não encontrado', 404);
        }

        // se mudar code, verifica duplicidade
        if (code && code !== position.code) {
            const exists = await Position.findOne({ where: { code } });
            if (exists) {
                return responseHandler.error(res, 'Código já cadastrado');
            }
        }

        if (departmentId !== undefined) {
            const department = await db.Department.findByPk(departmentId);
            if (!department) {
                return responseHandler.error(res, 'Departamento inválido');
            }
            position.department_id = departmentId;
        }

        position.name = name ?? position.name;
        position.code = code ?? position.code;
        position.description = description ?? position.description;
        if (is_internal !== undefined) position.is_internal = is_internal;
        if (is_partner !== undefined) position.is_partner = is_partner;
        if (active !== undefined) position.active = active;

        await position.save();
        return responseHandler.success(res, position);
    } catch (error) {
        return responseHandler.error(res, error);
    }
};

// DELETE /api/admin/positions/:id  (soft delete -> active = false)
export const deletePosition = async (req, res) => {
    const { id } = req.params;

    try {
        const position = await Position.findByPk(id);
        if (!position) {
            return responseHandler.error(res, 'Cargo não encontrado', 404);
        }

        position.active = false;
        await position.save();

        return responseHandler.success(res, { message: 'Cargo desativado com sucesso' });
    } catch (error) {
        return responseHandler.error(res, error);
    }
};
