import express from 'express';
import { ValidationHistory } from '../utils/db.js';
const router = express.Router();

// listar tudo (poderia paginar/filter)
router.get('/', async (req, res, next) => {
  try {
    const isSummary = String(req.query.summary).toLowerCase() === 'true';

    const all = await ValidationHistory.findAll({
      attributes: isSummary ? { exclude: ['mensagens'] } : undefined,
      order: [['createdAt', 'DESC']], // ou created_at
    });

    res.json(all);
  } catch (err) {
    next(err);
  }
});

// GET /validator/history            -> completo (com mensagens)
// GET /validator/history?summary=true -> resumido (sem mensagens)

export default router;
