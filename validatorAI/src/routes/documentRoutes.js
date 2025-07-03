// validatorAI/src/routes/documentRoutes.js
import express from 'express';
import { DocumentValidator } from '../services/DocumentValidator.js';
import { validateRequest } from '../middleware/validation.js';

const router = express.Router();

export const documentRoutes = (upload) => {
    router.post('', upload.fields([
        { name: 'contrato_caixa', maxCount: 1 },
        { name: 'confissao_divida', maxCount: 1 },
    ]), validateRequest, async (req, res, next) => {
        try {
            const contratoCaixa = req.files['contrato_caixa'][0];
            const confissaoDivida = req.files['confissao_divida'][0];

            const result = await DocumentValidator.validatePair(contratoCaixa, confissaoDivida);
            res.json(result);
        } catch (err) {
            next(err);
        }
    });

    return router;
};
