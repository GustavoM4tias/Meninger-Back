// api/controllers/buildingController.js
import Building from '../models/buildingModel.js';
import responseHandler from '../utils/responseHandler.js';

export const addBuilding = async (req, res) => {
    const { title, description, buildingDate, tags, images, address, created_by, stage } = req.body;

    // Validação
    if (!title || !description || !buildingDate || !created_by || !stage) {
        return res.status(400).json({ success: false, error: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }
    
    try {
        const newBuilding = await Building.addBuilding(req.db, {
            title,
            description,
            buildingDate,
            tags: tags || [], // Array de tags (adjetivos)
            images: images || [], // Array de URLs de imagens
            address: address || [], // Array de endereco
            created_by,
            stage
        });
        responseHandler.success(res, { message: 'Empreendimento criado com sucesso', buildingId: newBuilding.insertId });
    } catch (error) {
        responseHandler.error(res, error);
    }
};

export const getBuildings = async (req, res) => {
    try {
        const buildings = await Building.getBuildings(req.db);
        responseHandler.success(res, { buildings });
    } catch (error) {
        responseHandler.error(res, error);
    }
};

export const updateBuilding = async (req, res) => {
    const { id } = req.params;
    const { title, description, buildingDate, tags, images, address, stage } = req.body;

    try {
        const result = await Building.updateBuilding(req.db, id, { title, description, buildingDate, tags, images, address, stage });
        
        if (result.affectedRows === 0) {
            return responseHandler.error(res, 'Empreendimento não encontrado');
        }

        responseHandler.success(res, 'Empreendimento atualizado com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};

export const deleteBuilding = async (req, res) => {
    const { id } = req.params;

    try {
        const result = await Building.deleteBuilding(req.db, id);

        if (result.affectedRows === 0) {
            return responseHandler.error(res, 'Empreendimento não encontrado');
        }

        responseHandler.success(res, 'Empreendimento excluído com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};

