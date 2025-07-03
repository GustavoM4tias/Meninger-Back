// validatorAI/src/routes/statsRoutes.js
import express from 'express';
import { TokenUsage } from '../utils/db.js';  // o model do Sequelize

const router = express.Router();

/**
 * GET /validator/token-stats/total
 * Retorna o total de tokens consumidos (somatório de todos os registros).
 */
router.get('/total', async (req, res, next) => {
    try {
        const totalTokens = await TokenUsage.sum('tokensUsed');
        res.json({ totalTokensUsed: totalTokens || 0 });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /validator/token-stats/monthly
 * Retorna o consumo agrupado por mês e modelo.
 */
router.get('/mensal', async (req, res, next) => {
    try {
        // Exemplo: agrupa por YYYY-MM e modelo
        const [results] = await TokenUsage.sequelize.query(`
  SELECT 
    TO_CHAR(created_at, 'YYYY-MM') AS month,
    model,
    SUM(tokens_used) AS totalTokens
  FROM token_usages
  GROUP BY month, model
  ORDER BY month DESC;
`);
        res.json(results);
    } catch (err) {
        next(err);
    }
});

export default router;
