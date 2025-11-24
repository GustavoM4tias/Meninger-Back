// routes/mktExpenses.js
import { Router } from 'express';
import MktExpenseController from '../controllers/mktExpenseController.js';
import authenticate from '../middlewares/authMiddleware.js';

const router = Router();
const ctrl = new MktExpenseController();

router.use(authenticate);

router.post('/expenses', authenticate, ctrl.add);
router.get('/expenses',  ctrl.listMonth);

export default router;
