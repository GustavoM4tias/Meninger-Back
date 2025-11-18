// routes/mktExpenses.js
import { Router } from 'express';
import MktExpenseController from '../controllers/mktExpenseController.js';

const router = Router();
const ctrl = new MktExpenseController();

router.post('/expenses', ctrl.add);
router.get('/expenses', ctrl.listMonth);

export default router;
