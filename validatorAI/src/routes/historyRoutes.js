import express from 'express';
import { ValidationHistory } from '../utils/db.js';
const router = express.Router();

// listar tudo (poderia paginar/filter)
router.get('/', async (req, res, next) => {
    try {
        const all = await ValidationHistory.findAll({
            order: [['created_at', 'DESC']]
        });
        res.json(all);
    } catch (err) {
        next(err);
    }
});

export default router;
