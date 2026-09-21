// validatorAI/src/routes/documentRoutes.js
import express from 'express';
import { DocumentValidator } from '../services/DocumentValidator.js';
import { validateRequest } from '../middleware/validation.js';

const router = express.Router();

export const documentRoutes = (upload) => {
    /**
     * Prova de vida da API do validador.
     *
     * Existe porque o job chama o validador por HTTP, na URL de
     * `VALIDATOR_API_BASE_URL` — e uma URL errada no ambiente não aparece em
     * lugar nenhum até um contrato chegar e falhar. A sonda de saúde bate aqui
     * pelo MESMO cliente axios da análise, então ela testa a configuração de
     * verdade, não um caminho paralelo.
     *
     * Não devolve dado nenhum, e herda o portão de `/validator` no index.js
     * (token interno do job OU usuário com a alçada da tela).
     */
    router.get('/health', (req, res) => {
        res.json({ ok: true, service: 'validatorAI', at: new Date().toISOString() });
    });

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
